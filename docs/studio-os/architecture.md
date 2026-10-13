# VEER Studio OS: gate architecture

The canon for building VEER's own Gatekeepers on `os.veer.studio`. The decisions below are settled
(2026-10-11). Specs and builds follow them rather than reopening them. The platform facts were
verified against the pinned submodule `b304e8c2` and re-verified at `d420d9bb` (2026-10-13). Line
numbers drift on every bump, so treat a cited `path` plus identifier as "grep for the identifier".
Background: `os-technical-explore.md`.

## Scope

| Gate | What it is | Worker | Sidebar app |
|---|---|---|---|
| **Clients** | Minimal CRM: clients and deals | `veeros-gk-clients` | Clients |
| **Finance** | The books' system of record: clients' invoices and payments, vendor bills, subscriptions and domains, payouts, usage ledger. Replaces the Drive workbook "Financial Command Centre.xlsx" | `veeros-gk-finance` | Finance |
| **Projects** | Basecamp-like projects: message board, todo lists with a hill chart, Fizzy-style kanban | `veeros-gk-projects` | Projects |

Out of scope: an email Gatekeeper (email stays in agentic-inbox), patterns.center and ja.domains
(2027). The users are the two partners, both admins, plus occasional trusted contractors, who are
not admins.

## Decisions

1. **Every gate is a Gatekeeper with a sidebar app** (`providesUi`). None of them is a blueprint.
   Gadgets have no caller identity, cannot gate an agent's writes, cannot read each other's data, and
   have no backup. See "Why not gadgets".
2. **Three independent Workers**, one per gate. They integrate only through a declared RPC or HTTP
   API, or through gadgets. No gate reads another gate's storage.
3. **Identity follows the OS's own conventions.** Accounts are auto-provisioned
   (`autoProvisionsAccount` + `createAccount()`), and the only authority signal is
   `AppUiContext.isAdmin`. There is no claim or connect flow, and gates do not parse Access JWTs.
   Where a UI shows an author, it is a display name each person sets on their own account
   (self-declared, like the Docs blueprint's collaborator identity). Agent writes are marked as agent
   writes, together with the workspace they came from.
4. **The permission model is admin or not.**
5. **The UI is Kumo**, consistent with the Workshop. The template is the app pipeline in
   `gatekeeper-scheduler`.
6. **Humans act in the app, agents act through the session.** Human edits in the sidebar app take
   effect immediately and are written to the gate's own audit log. Agents can freely create, edit and
   move things. Those writes are `autoApprovable` with `delivery: "continue-with-simulation"`. **No
   agent action kind may be approval-only where that would stall the queue** (see Approvals).
   - In Projects, completing work (a todo done, a card in Done) is a **human-only operation in the
     app**. Agents move work into a **Review** state instead.
7. **Finance is admin-only and restricted.** Every agent read sets `containsRestrictedData`.
8. **After Foundation**, two side tracks:
   - Outbound communication: agentic-inbox's `/mcp`, reached through the existing `veeros-gk-mcp`.
   - External agents: an MCP facade Worker that calls `ExternalMessageGateway`. Finance is excluded
     from it.

## Platform constraints (verified at d420d9bb)

Paths are relative to `cloudflare-os/`. `gk.ts` is `packages/workshop-shared/src/gatekeeper.ts` and
`ov.ts` is `packages/workshop-backend/src/overseer.ts`.

### Accounts and identity

- `createAccount()` takes no arguments (`gk.ts`, `GatekeeperVendor.createAccount`). The sidebar app
  receives `AppUiContext = { isAdmin }` and nothing else. `ApprovalQueue` never exposes the caller,
  and `applyAction` learns neither who prompted nor who approved. **A gate never learns which human
  is acting.**
- The scheduler's pattern: `createAccount` returns `ctx.exports.<Account>({props:{accountId:
  crypto.randomUUID()}})`. The account is a stateless `WorkerEntrypoint`, and per-account state lives
  in a Durable Object reached with `getByName(accountId)` (`packages/gatekeeper-scheduler/src/scheduler.ts`).
- **The agent always acts through the workspace owner's account** (`ensureAmbientCapsules` uses
  `this.ownerId`). In a shared workspace, agent writes carry the owner's account even when a
  collaborator wrote the prompt.
- **An account's description is frozen when the account is created** (`user.ts`,
  `#createAutoProvisionedAccount`). `singleton`, `providesUi`, the app title and the icon must be
  right on the first deploy.
- **Gatekeeper modes in `/admin`** (`AdminConfig.ambientGatekeeperModes`): `optional` (the default)
  provisions an account only when a person opts in on the Connectors page, and lets them remove it,
  which calls `revoke()`; `enabled` provisions one for everyone and cannot be removed; `disabled`
  hides the app and, on each workspace's next open, removes the ambient capsule and **deletes its
  facet storage, including the kit journal and any pending actions**. Accounts survive `disabled`.

### The sidebar app

- `startAppUi(ctx)` runs on every page mount and returns `{ iframeHtml, ui }`. Its rendering is
  dynamic: no gatekeeper is hardcoded in `workshop-frontend/src/components/AppShell/Sidebar.tsx`. The
  app id is the vendor id, and there is one UI-declaring account per vendor per user.
- The iframe sandbox is `allow-scripts allow-modals`. It has **no popups, no downloads, no top
  navigation**. The CSP (`connect-src 'none'`) is **the app's own**: the host injects none, so
  studio-kit's build writes it into every page and fails if it is missing. All data flows through `ui`.
- The host accepts **one handshake per mount**. An app that reloads itself loses its session until the
  page is remounted, so error recovery re-renders instead.
- `ui` passes through a rate limiter (8 concurrent, 600 calls a minute) that forwards **top-level
  method names only**, so the `ui` API must be **flat**.
- The host also offers `subscribeTheme` (mode + accent colour), `openWorkspace(id, gadgetId?)`,
  `resolveWorkspaceTitles` (at most 100 ids), `openPrompt(text)` (which prefills the Home launcher's
  composer for a **new** workspace, at most 4000 characters, not submitted) and `setPresenting`.
- The sidebar draws an app's icon as a CSS mask, so icons are monochrome shapes.
- There are no deep links, no sidebar badges, and no reliable live push (poll instead).
- **Nothing in this path is audited and nothing goes through approvals.** We own authorization and
  the audit trail completely.
- Kumo reaches the null-origin iframe at build time: React, `@cloudflare/kumo` styles and Tailwind are
  inlined into one HTML file (`vite-plugin-singlefile`). Each app copies the Workshop's Kumo token
  overrides and applies `data-mode` and the accent colour from `subscribeTheme`. Scheduler's bundle is
  about 420 KB and Context's 2.0 MB.

### The agent path

- A `singleton` account gives every workspace the owner opens an **ambient capsule**. The set of
  ambient capsules is frozen per chat on first use, so a newly deployed gate appears only in **new**
  chats.
- A facet's `ctx.id.toString()` is the **workspace id**. Scheduler relies on this.
- `getAgentCatalog()` is injected into every chat's prompt and **is not an observation**. It must
  never contain restricted data.
- `types.d.ts` is the agent's only documentation. It must be self-contained, importing nothing except
  `cloudflare:workers`. That lint rule covers only the submodule, so we enforce it ourselves.

### Approvals

- Auto-approval needs three things: `autoApprovable === true` plus an `actionKind.tag`; a
  **per-workspace** rule for that gatekeeper and kind, created when someone clicks "Always approve
  this type"; and no restricted-data latch (`workshop-backend/src/auto-approval.ts`). Even an
  auto-approvable action pends **once per workspace per kind**.
- **The queue stops at the first action that needs a human** (`#drainOnce`) and never skips ahead. One
  manual-only kind would stall every later write from the same gate. Hence decision 6.
- A workspace that has read Finance auto-approves nothing at all, Projects writes included.
- Build descriptions with `gatekeeper-kit`'s `buildDescription` / `ActionDescriptionBuilder`. Never
  set `descriptionIsComplete` by hand, and never put agent text into the prose.
- Simulation: pending actions are folded over real state at read time (`createSimulationView` /
  `replaySimulation`). We are the system of record, so real ids can be minted at submit time.

### Observers

| Gate | Strategy | Notes |
|---|---|---|
| Clients, Projects | D, `openObservers()` | Studio data, with staff as the natural audience. Reads are `{kind:"baseline"}`. |
| Finance | C, `trackedCollectionObservers`, with one synthetic collection | The verifier is minted by the collaborator's own Finance account and checks that account's admin mark. Strategies A and B would refuse every non-admin `build` collaborator on every workspace an admin owns. |

Avoid the `withholdFromObservers` scope: a refused read latches the binding as unshareable.

### Shared data

- Studio-wide data lives in Durable Objects with fixed names that the gate owns. This is Context's
  pattern: `ctx.exports.X.getByName(name)`. Accounts hold only per-account state (display name, admin
  mark). `revoke()` clears per-account state only, never studio data.
- The kit's action journal lives in **facet storage**, which is per workspace, so a simulation is
  visible only inside that workspace. `applyAction` writes to the shared store and must be
  idempotent on `${workspaceId}:${actionId}`.

### Admin-only (Finance)

The OS has no per-user switch for a gatekeeper. Enforcement has three layers inside the gate:
1. **The app:** when `!isAdmin`, show an "admins only" page and expose a `ui` with no data methods.
2. **The agent path:** `startAppUi` records an admin mark on the account (set when `isAdmin`, cleared
   when not). Every session call checks it, so an admin has to open the app once first.
3. **Collaborators:** use tracked-collection observers (above), plus `containsRestrictedData` on every
   read.

Its catalog is `null`. Choose the mode deliberately: `optional` or `enabled` in `/admin`.

### gatekeeper-kit (`packages/gatekeeper-kit`)

| Use | Modules |
|---|---|
| Core | `actions` (`defineActions`, `fence: "none"`), `simulation`, `action-description`, `observers` |
| Maybe | `cursors` (pagination), `action-files` (receipts) |
| Skip | All connect, OAuth and credential modules |

- We would be the **first production users** of `actions`, `simulation` and the observer strategies.
  They are well tested, but upstream uses them only from the conformance fixture
  (`packages/gatekeeper-kit/__tests__/workerd/conformance/gatekeeper.ts`), which is the recipe to
  follow.
- The kit offers nothing for app UIs, hooks, slash commands or storage. Typed storage is the separate
  `packages/typed-storage` package, which has no migrations; Foundation chose hand-written SQLite
  with studio-kit's `migrate()` instead.
- Using the kit means adding `cloudflare-os/packages/gatekeeper-kit` and `packages/observability` to
  our `pnpm-workspace.yaml` (plus `typed-storage`, which builds to `dist`). Keep catalog entries
  byte-identical to the submodule's.

### Deploy wrapper

- `scripts/deploy.ts` drives the upstream MCP, GitHub and Email gates from the `vendorGatekeepers`
  table. That table assumes the packages live in the submodule, binds `entrypoint:
  "GatekeeperVendor"`, and derives `BASE_URL` from the binding name. `customGatekeeper` is a single
  slot.
- Rules we must keep:
  - **The generated configs of existing Workers stay byte-identical** when every studio gate is off.
  - **`workers_dev` and preview URLs stay off** on every Worker.
  - Gatekeepers that store stubs need the `allow_irrevocable_stub_storage` compatibility flag.
- Run `pnpm lint` as well as `pnpm check` and `pnpm test`. `pnpm check` does not compile disabled
  packages.
- **Nothing is deployed, no secret is set, and no Cloudflare config is changed without the user's
  explicit go-ahead.** Read the live version IDs before any deploy.

### Why not gadgets

Gadget code cannot tell who is acting, and the agent and the UI hold the same unfiltered stub, so
there is no way to require approval for the agent's data changes. Gadgets cannot reach each other's
data or other workspaces, and their data has no backup or version history. A gadget's data never
marks a workspace as holding restricted data, and previewing proposed code runs against live data.

Blueprints remain the layer for per-project documents (Docs, Sheets, Slides). A later "Project hub"
format would require Projects to expose URL-addressed resources, so that the binding survives into a
blueprint.

## Package layout

```
packages/studio-kit/      shared: app shell and theme, flat-ui helpers, audit log, account
                          profile and admin mark, action and observer wiring conventions, test helpers
packages/gate-probe/      Foundation's proving gate (veeros-gk-probe)
packages/gate-clients/    veeros-gk-clients
packages/gate-finance/    veeros-gk-finance
packages/gate-projects/   veeros-gk-projects
```

## How targets are built

Each target goes through the same steps:
1. **Brief:** `docs/studio-os/briefs/<target>.md`, written with the user.
2. **`studio-spec` workflow:** produces `docs/studio-os/specs/<target>.md`, ending in a Work breakdown.
3. **The user reviews the spec.**
4. **`studio-build` workflow:** builds it, gets checks green, reviews, and stops before deploy.
5. **Deploy:** only with the user's go-ahead.
6. **Manual verification** in a signed-in browser.

The order is Foundation, then Clients, Finance and Projects.
