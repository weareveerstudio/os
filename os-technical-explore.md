# Cloudflare OS — Technical Exploration

Working notes for the `os.veer.studio` deployment: what was changed to get push→deploy working
against the existing hosted-flow Workers, and what the upstream platform actually provides.

**Scope.** Findings are read from the pinned submodule at `54d5d8b0` (2026-09-08). Line references
are to that commit and will drift on upgrade. Anything not verified against source is marked as
such. §13 records what the latest bump changed. **Line references in §§1–12 were taken at
`6478a144` and have not all been re-verified** — treat them as "roughly here, grep for the
identifier". §§13–14 references are current.

**Status.** Deployed and verified 2026-08-23 at pin `6478a144`. Data retained. Extended 2026-08-29:
§8 with the session / ApprovalQueue mechanics, simulation, singletons and management UIs; §9.5 with
`gatekeeper-email`; §11.2 with the media-service sketch.

**Pin bumped 2026-09-09** to `54d5d8b0`, validated with `pnpm check`, **not yet deployed**. §13 is
the upgrade log; §14 covers the git-backed code storage and worktrees the bump brings in. The live
Workers still run the code built from `6478a144` until someone runs `pnpm deploy`.

---

## Contents

1. [Deployment: what changed and why](#1-deployment-what-changed-and-why)
2. [Live account inventory](#2-live-account-inventory)
3. [Context Gatekeeper](#3-context-gatekeeper)
4. [Blueprints and output formats](#4-blueprints-and-output-formats)
5. [Theming and CSS](#5-theming-and-css)
6. [Access and permissions](#6-access-and-permissions)
7. [Authentication mechanisms](#7-authentication-mechanisms)
8. [The Gatekeeper contract](#8-the-gatekeeper-contract)
   - 8.1 [The export map](#81-the-export-map)
   - 8.2 [Sessions and the ApprovalQueue](#82-sessions-and-the-approvalqueue)
   - 8.3 [“Simulating actions”](#83-simulating-actions)
   - 8.4 [Singleton gatekeepers and ambient capsules](#84-singleton-gatekeepers-and-ambient-capsules)
   - 8.5 [Management UIs (`providesUi`)](#85-management-uis-providesui)
   - 8.6 [Packaging note](#86-packaging-note)
9. [Gatekeeper survey](#9-gatekeeper-survey)
    - 9.5 [`gatekeeper-email` — the Gatekeeper that *is* the service](#95-gatekeeper-email--the-gatekeeper-that-is-the-service)
10. [Credentials and secrets](#10-credentials-and-secrets)
11. [Design sketches](#11-design-sketches)
    - 11.1 [Client portal and billing](#111-client-portal-and-billing)
    - 11.2 [Media service on R2](#112-media-service-on-r2)
12. [Open items](#12-open-items)
13. [Upgrade log: `6478a144` → `54d5d8b0`](#13-upgrade-log-6478a144--54d5d8b0)
14. [Git-backed code storage and worktrees](#14-git-backed-code-storage-and-worktrees)
    - 14.1 [One store per workspace, not one repo per gadget](#141-one-store-per-workspace-not-one-repo-per-gadget)
    - 14.2 [What is *not* involved: Artifacts, R2, refs](#142-what-is-not-involved-artifacts-r2-refs)
    - 14.3 [The merge model: the chat is the branch](#143-the-merge-model-the-chat-is-the-branch)
    - 14.4 [Worktrees — mounting a remote commit](#144-worktrees--mounting-a-remote-commit)
    - 14.5 [The git flows exposed to the agent](#145-the-git-flows-exposed-to-the-agent)
    - 14.6 [`GitCache` — the gatekeeper side](#146-gitcache--the-gatekeeper-side)
    - 14.7 [What this means for us](#147-what-this-means-for-us)

---

## 1. Deployment: what changed and why

This deployment was created by the hosted flow (`os.cloudflare.app/deploy`) and ejected to this
starter repo. Four problems had to be solved before `pnpm deploy` was safe to run.

### 1.1 The MCP Gatekeeper would have been silently orphaned

**The bug.** `generateConfigs` assigns `router.services` and `workshop.services` *wholesale*
(`scripts/deploy.ts`), and knew only four Gatekeeper bindings. Because `wrangler deploy` replaces
bindings, deploying would have dropped `GATEKEEPER_MCP` — leaving `veeros-gk-mcp` running with its
Durable Object data intact but bound to nothing, and the connector silently gone from the app.

This is the failure mode `docs/migrate-from-hosted.md` §7 describes: Gatekeepers installed through
the hosted wizard keep running as Workers, but the generated configs no longer carry their
`GATEKEEPER_*` service binding.

**The fix.** MCP became a first-class deployable Worker in `scripts/deploy.ts`:

- `packageDirs.mcp` → `cloudflare-os/packages/gatekeeper-mcp`
- Bound as `GATEKEEPER_MCP` on the router (bare) and on the Workshop (`entrypoint:
  "GatekeeperVendor"`, no props — only Context takes a prop)
- One build step: `vp run -F @gadgets/mcp-gatekeeper --no-cache build`. Unlike Context and
  Scheduler it needs no paired `build:app` call, because its `build` is a Vite+ *task* declaring
  `dependsOn: ["build:configurator"]`, so `--no-cache` reaches the codegen through the dependency
  rather than being swallowed by a nested `vp run`.
- Deployed before the Workshop, after the Scheduler

Router path is `/gatekeeper/mcp` — `<short>` is the binding name minus its prefix, lowercased.

### 1.2 `BASE_URL` was missing on the MCP Worker

**The bug, and why it was easy to miss.** The hosted deploy sets `BASE_URL` on every Gatekeeper;
this wrapper sets it on none. That never mattered, because neither Context nor Scheduler reads it —
only OAuth-style Gatekeepers do. MCP is the first one this deployment runs.

`getBaseUrl()` in `gatekeeper-mcp/src/mcp.ts:89` falls back to
`http://localhost:8787/gatekeeper/mcp` when unset, and it feeds the connect form and **OAuth
callback** handler. Unset in production, every OAuth redirect handed to a remote MCP server would
have pointed at localhost — a failure surfacing only when a user first tried to connect a server.

**The fix.** `deploy.ts` now derives it: `BASE_URL: ${origin}/gatekeeper/mcp`. Verified in the
dry-run as `https://os.veer.studio/gatekeeper/mcp`.

> **Rule for any future OAuth Gatekeeper: it needs `BASE_URL`.** Nothing enforces this — the deploy
> succeeds without it.

### 1.3 Custom Gatekeeper and Error Reporter made optional

Error reporting was already a clean flag. The custom Gatekeeper was not: its names were in
`requiredPaths` and `GATEKEEPER_CUSTOM` was bound unconditionally on both the router and the
Workshop.

It now mirrors the `errorReporter` pattern exactly — gated in validation, placeholder scanning,
Worker-name uniqueness, config generation, both binding lists, the build, and the deploy. Code stays
in `packages/custom-gatekeeper/` for a later iteration; nothing is built, deployed, or bound while
`customGatekeeper.enabled` is false.

### 1.4 AI Gateway name was wrong

`aiGateway.name` was `"default"`. The hosted flow creates `<instance>-ai`, and the deployed Workshop
confirmed `CF_AI_GATEWAY ("veeros-ai")`. Per `docs/migrate-from-hosted.md` §5 a wrong gateway name
**silently empties the model picker** — the deployment looks healthy and offers no models.

Also added `"anthropic"` to `providers`. The `veeros-ai_anthropic_default` key lives in the
**gateway's own Secrets Store**, not the Worker, so it needs no `CF_AI_GATEWAY_API_TOKEN` — but the
provider must be listed or its models are never advertised. Provider order is irrelevant; it is
parsed into a `Set`.

### 1.5 Tests

`scripts/deploy.test.ts` gained four cases covering the new paths — a disabled Gatekeeper dropping
out of *both* binding lists, an enabled one still requiring a Worker name, build steps skipped when
disabled, and MCP's `BASE_URL` / `MCP_ALLOW_INSECURE` vars. **30/30 pass.**

---

## 2. Live account inventory

Verified against the account on 2026-08-23.

| Item | Value |
|---|---|
| Account | VEER Studio · `cae2b6350c3a5a8bc9451652ffb0c9d7` |
| Public origin | `https://os.veer.studio` (custom domain on the router) |
| AI Gateway | `veeros-ai`, providers `cloudflare` + `anthropic` |

### Workers

| Worker | Role | Deployed by this repo |
|---|---|---|
| `veeros` | Router — the only public route | ✅ |
| `veeros-backend` | Workshop — **all user data** (Durable Objects) | ✅ |
| `veeros-gk-context` | Context Gatekeeper | ✅ |
| `veeros-gk-scheduler` | Scheduler Gatekeeper | ✅ |
| `veeros-gk-mcp` | MCP Gatekeeper | ✅ (added this iteration) |

Custom Gatekeeper and Error Reporter are disabled — not deployed, not bound.

### Storage

| Binding | Resource |
|---|---|
| `CONTEXT_COLLECTIONS` | `b203bda152124baa9ff21e147c182537` (`veeros-context-collections`) |
| `BLUEPRINTS` | `4ee876087f654c14a2129953d0308152` (`veeros-blueprints`) |
| `AVATARS` | `380a24bf2d82473fab8040db6c91678d` (`veeros-avatars`) |
| `BLUEPRINT_CONTENT` | `veeros-blueprint-content` (R2) |
| `ARTIFACTS` | `veeros-context-collections` (namespace; enabled this iteration) |

### Rollback baseline (pre-deploy versions)

```
veeros                 07add0bb-5cf9-4ce4-b40f-1c725a4899a1
veeros-backend         b96e9cf1-3c24-4e8d-9a03-8223436b89af
veeros-gk-context      c7294bc9-1690-42be-aa55-25515292aa8e
veeros-gk-scheduler    9c583708-c57f-47d8-94f7-7ab27bb46a34
veeros-gk-mcp          bbf28977-9ce0-4442-b5c9-6bf330dad897
```

The prior release was `dev-tjd58j` (2026-08-10); the pin is 8 days newer, so this was an upgrade,
not a downgrade. Workshop DO migrations v0–v2 are all additive `new_sqlite_classes` — no deletes or
renames.

### Notes

- The Workshop carries a leftover `CF_AI_GATEWAY_API_TOKEN` secret from the hosted flow. It survives
  deploys and is **unused** — transport picks the `WORKERS_AI` binding unless
  `CF_AI_GATEWAY_USE_BINDING=false`.
- `DEPLOY_URL` was dropped, removing the "manage this deployment" link. Expected; documented in
  `docs/migrate-from-hosted.md` §7.
- `context.sharingDomain: null` derives `https://os.veer.studio`, which **matches** the hosted
  instance's origin — the Context data boundary was preserved. Had the hosted instance been on
  `workers.dev`, this would have silently hidden all collections.
- Local Node is 24.15.0 against a declared `>=24.19.0`. Only a warning; `pnpm check` passes.

---

## 3. Context Gatekeeper

An **ambient** Gatekeeper holding collections of documents, exposed to the agent as a catalog it can
search and read.  UI at `https://os.veer.studio/gatekeeper/context`.

### 3.1 Collections

Two content sources (`context-types.ts:97`):

| Source | Content managed via | Requires |
|---|---|---|
| `{ source: "web" }` | The Context UI | — |
| `{ source: "git", remote, branch, commit }` | `git push` to an Artifacts repo | Artifacts (enabled) |

Visibility is `"public"` or `"private"`, and the authorization is only two branches
(`context-api.ts:89`–`108`):

| Visibility | Read | Write |
|---|---|---|
| `private` | Owning account only | Owning account only |
| `public` | Every user in the deployment | **Admins only** |

There is **no ACL, no collaborator list, and no share link for collections.** "Shared with these
three people but not everyone" does not exist. `public` + admin-only-write is the intended shape for
a curated house knowledge base.

### 3.2 Skills

A skill is **any file named exactly `SKILL.md`**, anywhere in any collection
(`agent-skill.ts:129`). No manifest, no registration, no admin step. Each becomes a slash command
*and* an agent catalog entry.

```markdown
---
name: weekly-status
description: Draft the weekly client status note from the project's context docs.
---

Write a status update for $ARGUMENT following our house format...
```

- `name` — lowercase, numbers, single hyphens, ≤64 chars → `/weekly-status`
- `description` — ≤1024 chars; this is what the agent uses to judge relevance
- `$ARGUMENT` is substituted; if absent, argument text is appended
- The body is delivered with a **skill root**, so a skill can be a folder (`SKILL.md` plus reference
  docs) and cite siblings by relative path
- Catalog advertises at most **150** skills (`AGENT_SKILL_CATALOG_MAX_ENTRIES`); collections always
  win the remaining space. Skills past the cap remain searchable but unadvertised.

### 3.3 Size limits

**One document limit shared by both modes: `MAX_DOCUMENT_BODY_BYTES = 1_400_000`**
(`context-types.ts:212`). Enforcement differs, and this is the trap:

| | Web / UI mode | Git mode |
|---|---|---|
| Checked at | `context-collection.ts:361`, on write | `artifact-sync.ts:241`, on sync |
| Over limit | **Throws** | **Silently skipped** — logs `context.file.oversized.skipped` |

Push a 2 MB file to a git-backed collection and it simply is not there. No error, no failed sync.

- **Binary is measured base64-encoded** (`Math.ceil(len / 3) * 4`), so the real ceiling for binary is
  **~1.05 MB** of raw bytes.
- **Git mode has a repo-wide cap:** `MAX_GIT_DIR_BYTES = 64 MB` (`artifact-sync.ts:26`), covering the
  working directory *including git objects* — history counts toward it.
- Path length: 1024 characters.

### 3.4 Indexing — there is none

`search()` (`context-collection.ts:598`) is a **linear scan with substring scoring**:

```ts
for (let record of this.storage.documents.list()) {
  for (let token of tokens) {
    if (nameLower.includes(token)) score += 10
    if (descLower.includes(token)) score += 5
    if (bodyLower.indexOf(token) >= 0) score += 1   // + first snippet
  }
}
results.sort((a, b) => b.score - a.score)
return results.slice(0, limit)   // default 20
```

No embeddings, no vector search, no inverted index, no BM25, no stemming. Body matching is skipped
entirely for non-text types, so **binary files are searchable by name and description only**.

**Name is worth 10× a body hit; description 5×.** `description` is auto-extracted from YAML
frontmatter for text files. Naming files well and writing real frontmatter descriptions is the
highest-leverage thing available for retrieval quality.

Practical consequences:

- Many small documents beat few large ones — a body hit scores +1 and only the *first* snippet is
  captured, so a large reference doc is a weak search target regardless of relevance.
- The agent matches literal substrings. Consistent house vocabulary does the work an embedding model
  would otherwise do.

### 3.5 The agent's read path

Three RPCs on `LibraryReadSession`, scoped to *enabled* collections:

| Call | Behaviour |
|---|---|
| `list({collectionId?, path?})` | Browse collections or a path prefix |
| `search(query, {collectionId?, limit=20})` | Fans out, `MAX_COLLECTION_FANOUT = 8` concurrent |
| `read(docId)` | Full document; binary as a `data:` URI |

Above them sits the catalog: collections (against `AGENT_CATALOG_MAX_ENTRIES = 1000`) then up to 150
skills. Entries carry the literal usage instruction `"Read with env[N].read(id) and
console.log(document.content)"`.

Every read/list/search is authorized as an **observation** and attributed to the collections it
reveals. `read()` and `list()` deliberately record nothing when empty.

**Git refresh is lazy** — `listContextDocuments`, `search`, and `listAgentSkills` each kick off a
background refresh. After a `git push`, the update lands on a *subsequent* read.

---

## 4. Blueprints and output formats

### 4.1 What a blueprint is

A snapshot of a gadget's **source code** (a Yjs document stripped of history), plus binding
*requirements* and metadata. It does **not** capture SQLite storage, chat history, or credentials —
only the *shape* of each binding.

Blueprints cannot be authored as source files. A `.gadget` is a binary container built in a running
Workshop and exported.

### 4.2 Extracting a built-in blueprint's source

The three bundled formats live in `cloudflare-os/packages/workshop-backend/format-blueprints/`:

| Archive | Blueprint ID | Sidecar |
|---|---|---|
| `workspace-docs.gadget` | `format.document` | `workspace-docs.json` |
| `workspace-sheets.gadget` | `format.spreadsheet` | `workspace-sheets.json` |
| `workspace-slides.gadget` | `format.slides` | `workspace-slides.json` |

Layout: 24-byte header (magic `0xec2e2d3a2300e317`, format version, metadata length, content
length), JSON metadata, then a **gzipped Yjs V2 snapshot** of the files.

> **Obsolete since pin `54d5d8b0`.** Upstream #265 unpacked the bundled blueprints: the `.gadget`
> binaries are gone, replaced by one directory per blueprint holding a `blueprint.json` manifest and
> reviewable sources under `files/` — read `format-blueprints/workspace-docs/files/server.js`
> directly, no extraction needed. `scripts/build-format-blueprints.ts` reconstructs the archive
> representation at build time, so `FORMAT_BLUEPRINTS_DIR` still works the same way for a fork
> shipping its own set. The install fingerprint now also covers the generated archive's content
> hash, not just `revision`. The header format below is retained because exported `.gadget` files
> (the `/admin` export path) still use it.

A working extraction script is at `scratchpad/extract-gadget.mjs`:
`node extract-gadget.mjs <file.gadget> <output-dir>`.

Workspace Docs decodes to three files — `server.js` (15,760 chars), `client.js` (71,254 chars),
`README.md` (6,157 chars). Its declared bindings are `{}`, so it instantiates with no connections.

> **Correction to an earlier assumption.** There is **no Yjs runtime model** in the document
> blueprint. Yjs is only how the blueprint *archive* stores source files. Workspace Docs' own README
> describes its architecture as a Durable Object storing *"one atomic `document:v2` snapshot
> containing the title, global revision, ordered blocks"*, with concurrent edits serialized by
> chained mutations and a global revision number — a revision scheme, not a CRDT. Read that
> `server.js` before assuming CRDT merge semantics.

### 4.3 Formats and the Outputs page

A *format* is an ordinary blueprint the deployment has **promoted** (`AdminConfig.formats`, the
admin **Formats** panel). A blueprint may declare `BlueprintMetadata.output`: a grouping `id`, a
`noun`/`plural`, and an `icon` from a closed set.

```ts
export const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"] as const;
```

**Outputs filter chips** are built in `routes/outputs.tsx:530` in three passes:

1. `Apps` seeded first, unconditionally
2. Each promoted format, in deployment order
3. Any `output.id` present on existing outputs but not yet covered — *"so existing outputs never
   lose their filter"* when a format is later un-promoted

Chips are keyed by `output.id`, labelled by `output.plural`; they render only when more than one
exists. `All` is separate and always shown.

**"Apps" is `GENERIC_OUTPUT`** (`components/format/formats.ts:59`):

```ts
{ id: 'app', noun: 'App', plural: 'Apps', icon: 'appWindow' }
```

`formatOf()` returns it when a gadget **declares no `output`** (every ordinary gadget) *or* declares
an icon this build does not recognise — deliberate graceful degradation when a deployment serves a
format newer than the browser's cached bundle.

### 4.4 Shipping our own formats

Two routes. **Path A was chosen for this iteration.**

**A. Promote via `/admin` → Formats.** No code, no redeploy. Chips appear automatically from
`output.id` / `output.plural`. This is the mechanism bundling is a convenience on top of.

**B. Bundle as data.**
`FORMAT_BLUEPRINTS_DIR=<dir> pnpm import:format-blueprint <export.gadget> --new <id>` writes the
`.gadget` + `.json` pair and regenerates the bundled module. Caveats:

- `FORMAT_BLUEPRINTS_DIR` **replaces** the default set — Docs/Sheets/Slides are lost unless copied
  across.
- The directory must live in *this* repo, not the submodule; upstream warns that adding files there
  conflicts on every gitlink bump.
- Needs wiring into `buildCommands()` in `scripts/deploy.ts` (same shape as `VITE_CF_ACCESS_MODE`).
- `blueprintId` is the install key. Changing it after deploy promotes a **second** format and
  orphans the first. Rename files freely; never the id.

Planned blueprints: message board, todo list, kanban — Basecamp-5 styled, built in-platform from
`format.document`. Suggested icons: `notebook`/`appWindow`, `listChecks`, `kanban`. Keep `output.id`
generic (`board`, not `veeros-kanban`) since it is the Outputs grouping key.

---

## 5. Theming and CSS

**There is no CSS customization hook** — documented or otherwise. Verified: no
`customCss`/`injectCss`/`themeCss` anywhere; the frontend's only `VITE_*` variables are
`BACKEND_HOST`, `CF_ACCESS_MODE`, `DEV_*`, `FRONTEND_ERROR_REPORTING`; and this repo's
`vite.config.ts` is lint-only and explicitly ignores `cloudflare-os/**`.

The complete admin visual surface is `setSiteName`, `setSiteLogo`, `setAccentColor`,
`setAnnouncement`, `setBanner`.

`setAccentColor` is more capable than it sounds: one validated hex seed expands through
`accentVariables()` into a family of custom properties (`--color-accent-100/200`,
`--color-shadow-accent-*`) set on `document.documentElement`; an empty/invalid value removes them,
falling back to `styles.css` defaults (`#ff4801` light, `#b84e00` dark). It also propagates into
sandboxed Gatekeeper configurator UIs via `updateTheme`.

Everything else is Cloudflare's **Kumo** design system (`bg-kumo-base`, `text-kumo-subtle`,
`border-kumo-line`) with light/dark palettes keyed off `data-mode`. No override hook.

**Gadget code is unconstrained** — Basecamp-5 styling in our own blueprints is entirely ours. Only
the Workshop chrome is fixed.

---

## 6. Access and permissions

Three independent layers:

| Layer | Granularity | Set by |
|---|---|---|
| Cloudflare Access | Who reaches `os.veer.studio` | Access policy |
| Global tier | **Two only**: admin / everyone else | `access.admins` |
| Per-workspace role | **Three**: owner > build > use | Workspace owner |

No third global tier, no custom roles. Admin is a flat boolean from `ADMINS` (`server.ts:100`).

### Per-workspace roles

- **`use`** — render and interact with the deployed UI, read `id`/`title`/`owner`/`role`, see
  presence. Everything else throws `Unauthorized`. Default-deny by construction:
  `UseOverseerInterface` *implements* `Overseer`, so a new method fails to compile until someone
  decides whether `use` may call it.
- **`build`** — full access except: cannot delete (owner only); uses **their own** AI models (BYOK
  bills whoever prompted); uses **their own** connected accounts for bindings.

Effective role is recomputed live from a permission graph at every `open()`. Revocation is lazy —
severing an edge is enough — and removals abort the workspace DO after flushing, so an open session
dies within ~100 ms rather than lingering.

### What is not possible

**Gadget creation cannot be restricted.** `newGadget()` (`server.ts:282`) has no role check; any
authenticated user can create a workspace. There is no per-user capability flag.

Membership is the lever instead: Access policy decides who reaches the app, and
`setSignupsEnabled(false)` makes a first-time Access-authenticated visitor **rejected** rather than
auto-provisioned (`user.ts:328`), while existing accounts keep working. Pattern: let each person
sign in once with signups on, then close it.

### Upstream roadmap

`docs/sharing.md` future work lists chat-only and read-only permission levels, resharing of `use`,
binding-aware access control, and share-link expiry.

---

## 7. Authentication mechanisms

Three, and `CF_ACCESS_AUD` is a **master switch**, not a preference.

| Method | Where auth happens | Status here |
|---|---|---|
| Cloudflare Access | Before the request reaches the Worker | ✅ Running |
| Built-in password accounts | Inside the Workshop (upstream default) | Refused while Access is on |
| Auth Gatekeepers (OAuth) | Inside the Workshop | Not deployed |

With `CF_ACCESS_AUD` set:

1. Every `/api` request needs a valid Access JWT plus a same-origin check (`server.ts:839`)
2. `login()` and `createAccount()` **throw unconditionally** (`server.ts:719`, `:743`) — password
   auth is refused, not merely hidden
3. `VITE_CF_ACCESS_MODE` is a **build-time constant**, so the login UI is not in the bundle

Gatekeeper *sign-in* has no server-side guard but is unreachable in Access mode. A Gatekeeper used
as an ordinary **connector** works fine.

**Identity is always the verified email** — all three key the account by `idFromName(email)`, so
switching methods does not strand data.

### Configuring the alternatives

```
AUTH_GATEKEEPERS=cloudflare,google,github   # order = button order
DISABLE_PASSWORD_AUTH=true                  # optional, OAuth-only
```

Only `cloudflare`, `github`, `google` advertise `providesAuth`. `DISABLE_PASSWORD_AUTH` is ignored
unless the allowlist is non-empty — a deliberate anti-lockout guard. OAuth credentials live as
secrets on the **gatekeeper Workers**; redirect URIs are
`https://os.veer.studio/gatekeeper/<vendor>/oauth`.

Sign-in requests minimal scopes and the grant **self-destructs** after the email is read; full scopes
come only on explicit connect.

**This repo hard-codes Access mode** — no `AUTH_GATEKEEPERS` support exists in `scripts/` or
`deployment.jsonc`. `docs/customization.md:83-84` states both alternatives require deploy script
changes.

---

## 8. The Gatekeeper contract

**`cloudflare-os/packages/workshop-shared/src/gatekeeper.ts`** (1283 lines, ~63 KB), exported as
`@gadgets/workshop-shared/gatekeeper`. This is the whole contract — every Gatekeeper in the repo
implements interfaces declared in this one file.

### 8.1 The export map

| Export | Line | Role |
|---|---|---|
| `GatekeeperVendor` | 445 | What the Workshop binds — `describe()`, `connectAccount()`, `createAccount()` |
| `GatekeeperUser` | 567 | Per-user surface once connected |
| `Gatekeeper<Session>` | 698 | The DO holding a connection |
| `GatekeeperConnectCallback` | 525 | OAuth completion |
| `GatekeeperUserVerifier` | 689 | Observer verification |

Supporting vocabulary: `VendorDescription` (38), `AccountDescription` (148), `ResourceDescription`
(185), `SupportedResource` (236), `AgentCatalog` (105) with caps at 125–128
(`AGENT_CATALOG_MAX_ENTRIES = 1000`, id 256, title 100, description 400), `ObservationAuthorizer`
(855), `ObservationDescription` (1049), `ApprovalQueue` (934), `SlashCommandProvider` (908),
`ActionDescription` (1129), `ActionKind` (1117), `HookController`/`HookInitiator` (1244, 1273),
`GatekeeperUiFrame` (414), `ResourceConfiguratorIframe`/`Host` (348, 372).

Authoring guide: `cloudflare-os/.agents/skills/write-gatekeeper/SKILL.md` (343 lines) plus
`SKELETON.md`.

### 8.2 Sessions and the ApprovalQueue

The ApprovalQueue is not something a session looks up. It is **the argument that creates the
session** (`gatekeeper.ts:738`):

```ts
startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session>;
```

Every channel the session has back to the platform arrives through that one stub. There is no
ambient path.

**The chain, from a binding name in `env` to a row in the audit log:**

1. **`GatekeeperLoopback`** (`workshop-backend/src/overseer.ts:7088`) — a dynamic isolate's `env` can
   hold `ServiceStub`s but not `RpcStub`s, so each binding is a `WorkerEntrypoint` whose
   *constructor* opens the session and returns a `Proxy` over it. Its own comment calls this a
   "horrible hack". Props carry `{overseerId, target, caller}`.
2. **`startGatekeeperSession(target, caller)`** (`overseer.ts:2774`) → builds a
   `GatekeeperClientImpl`, calls `openSession()`.
3. **`openSession()`** (`overseer.ts:9666`):
   ```ts
   return this.facet.startSession(new ApprovalQueueImpl(this.impl, this.id, this.caller));
   ```
4. **`ApprovalQueueImpl`** (`overseer.ts:9695`) is ~15 lines. It captures `{impl, gatekeeperId,
   caller}` and forwards three methods. **The entire security value of the object is the two fields
   it closes over** — which gatekeeper, and on whose behalf.
5. **`getGatekeeperFacet(id)`** (`overseer.ts:2657`) resolves the gatekeeper as a **Durable Object
   Facet** (`ctx.facets.get('gatekeeper<id>')`) — a child DO of the Overseer, not a separate service.

`GatekeeperCaller` (`overseer.ts:7047`) is the provenance stamped on every record:

```ts
{from:"agent", chatId} | {from:"gadget", chatId?, gadgetId?} | {from:"user", chatId?} | {from:"hook"}
```

#### The three methods behave very differently

| | `authorizeObservation` | `submitAction` | `bindHook` |
|---|---|---|---|
| Blocks on a human? | **never** | never (returns at once) | never |
| Record state | `"approved"` | `"pending"` | `"approved"`, `enabled:false` |
| Can throw? | **yes — this is the gate** | only on plumbing failure | — |
| Decided later by | — | `applyAction` / `rejectAction` | `enableHook` |

`authorizeObservation` is the one that surprises people: in the normal case it is **logged, not
gated**. It writes an already-approved audit row (`overseer.ts:2860`) and returns. It throws in
exactly two situations (`overseer.ts:2839-2858`):

- **`prohibitAllSharing`** — if the workspace already has shares, the read is refused. Otherwise the
  flag is *latched on the workspace*: permanent lockdown, no further actions (`overseer.ts:3051`)
  and no web fetches (`getWebFetchEnv`, `overseer.ts:3010`).
- **`excludeObservers`** — `#enforceExcludeObservers` maps each opaque observer id back to a
  profile; if any named observer is still authorized in the sharing graph the read is blocked,
  because v1 has no per-thread hiding.

#### Two independent action-ID spaces

- The **gatekeeper** assigns its own action number (`counter:nextActionId` in its own DO —
  `gatekeeper-homeassistant/src/homeassistant.ts:1386`).
- The **overseer** assigns a separate `actionId` for the audit row (`overseer.ts:3060`).
- `applyAction(record.action)` passes the **gatekeeper's** number back (`overseer.ts:2676`). The
  overseer's id never crosses the boundary.

This is why every gatekeeper keeps `pending:<id>` rows: the callback carries only an integer, so all
context must be recoverable from local storage.

#### Approve and reject

`applyPendingAction` (`overseer.ts:2671`) is the single chokepoint to `state:"approved"`:

```ts
async applyPendingAction(record, resolvedBy: AiChatAuthorInfo, autoApproved: boolean)
```

`resolvedBy` and `autoApproved` are **required, not defaulted** — a deliberate design note in the
comment: no apply path can omit how the gate was cleared. `approveAction` (`overseer.ts:7826`)
resolves the approver's profile *before* applying, so a failed profile fetch can't leave an action
applied in the world but `"pending"` in storage.

**Auto-approval requires two independent gates** (`overseer.ts:3086`) — the gatekeeper author's
per-action `autoApprovable` verdict, *and* the workspace's opt-in rule keyed on
`actionKind.tag`:

```ts
let willAutoApprove = !!(description.autoApprovable && description.actionKind &&
    this.storage.autoApproveTags.get(`${gatekeeperId}:${description.actionKind.tag}`) !== undefined);
```

`drainAutoApprovals` applies in ascending id order and **stops at the first non-eligible pending
action** — never skipping ahead of a human gate. `getAutoApprovableActions()` (`gatekeeper.ts:721`)
exists so a pre-approval UI can list what *could* be auto-applied before any action exists.

#### `awaitDecision`: suspending the agent turn

```ts
// overseer.ts:3092
if (caller.from === "agent" && description.awaitDecision && !willAutoApprove) {
  this.#getOrCreateCapturedActions(caller.chatId).awaitDecision = true;
}
```

`#maybeResumeAfterActionDecision` (`overseer.ts:7930`) walks the chat log back to the turn boundary
and resumes **only if every awaited action in that turn was decided and all were approved**. One
denial leaves the turn ended. On resume it injects: *"The changes you submitted have been approved
and applied: … Reads now reflect them."*

#### Hooks — the fourth caller, with no human present

`bindHook` stores the controller plus the **persistent** callback stub (`overseer.ts:3097`);
persistence is required because sessions die, explained at length at `gatekeeper.ts:960-1040`. On
`enableHook` the overseer hands the gatekeeper a `GatekeeperHookLoopback` implementing
`HookInitiator`. At fire time (`overseer.ts:6913`):

```ts
return {
  callback: record.callback,
  approvalQueue: new ApprovalQueueImpl(this.impl, record.gatekeeperId, {from: "hook"}),
};
```

A fresh ApprovalQueue materializes for an event nobody triggered. `startHook` re-checks
`record.enabled` and the admin's `disabledGatekeepers` list, so disabling takes effect on live hooks.

**Known race, documented upstream** (`overseer.ts:7889`): a concurrent `disableHook` can land its
`controller.disable()` before an in-flight `enable()`, letting the enable resurrect gatekeeper-side
state that keeps consuming alarms and quota. Live firings stay safe; the orphaned row does not get
cleaned up.

#### Flows this architecture supports

1. **Read-only ambient** — Context Library; `applyAction` throws `"read-only and implements no
   actions"` (`gatekeeper-context/src/library-gatekeeper.ts:355`).
2. **Read + queued writes, simulated** — HA, GitHub, Notion, Linear, Google, Spotify, Confluence.
3. **Read + queued writes, not simulated** — Supabase, MCP portal; both set `awaitDecision: true`.
4. **Auto-approved kinds** — applied without a prompt, still logged with `autoApproved: true` and
   `resolvedBy` = whoever enabled the rule.
5. **Hook-driven** — Scheduler, Slack. Event → `startHook()` → new queue → `authorizeObservation` →
   deliver to gadget.
6. **Slash commands — deliberately attenuated.** `SlashCommandProvider.invoke()` receives a
   `SlashCommandAuthorizerImpl` (`overseer.ts:9683`) implementing *only* `ObservationAuthorizer`.
   It structurally cannot submit actions or bind hooks. Same attenuation for `getAgentCatalog`.
7. **Lockdown** — one `prohibitAllSharing` observation makes the workspace read-only for good.

### 8.3 "Simulating actions"

The contract *suggests* it (`gatekeeper.ts:730`):

> It is **suggested** that the gatekeeper "simulate" actions that have not been approved yet […]
> That said, there is **no strict requirement**.

It is a recommendation, and `awaitDecision` is the sanctioned opt-out.

**Why it exists.** `submitAction` returns immediately but the write does not happen — possibly for
days. Without simulation an agent writes, reads back, sees its write missing, and starts "retrying,
second-guessing, or undoing its own work" (`gatekeeper.ts:1160`).

**How it is implemented — overlay at read time.** Home Assistant is the reference. Nothing is ever
mutated; pending actions are folded over real state on each read.

Write path (`homeassistant.ts:1286`) — store first, submit second, roll back the row if submit fails:

```ts
const id = self.#nextActionId();
self.ctx.storage.kv.put<PendingActionRow>(`pending:${id}`, { id, action, submittedAt: Date.now() });
try {
  await approvalQueue.submitAction(id, description);
} catch (e) {
  self.#deletePending(id);   // queue stub gone — don't leave a phantom
  throw e;
}
```

Read path (`homeassistant.ts:2714`) — note the short-circuit that keeps the common case at one
round-trip:

```ts
const pending = this.#ctx.listPendingActions();
if (pending.length === 0) {
  raw = await callApi(this.#ctx, r => r.getState(this.#entityId));   // one REST call
} else {
  const [rawState, registry] = await Promise.all([...]);             // registry needed to resolve targets
  const result = overlayEntityState(rawState, pending, registry);
  raw = result.state;
  appliedCount = result.appliedCount;
}
await this.#ctx.approvalQueue.authorizeObservation({
  title: `Read entity state`,
  description: `Read state of \`${this.#entityId}\` (current: ${state.state})` +
      pendingSuffix(appliedCount) + `.`,
});
```

`pendingSuffix(appliedCount)` is the honest part: **the approver is told how much of what the agent
read was imaginary.**

`overlayEntityState` (`simulation.ts:327`) is a pure fold; `applyServiceToState` (`simulation.ts:68`)
is a `switch` over `${domain}.${service}` that **returns the input unchanged for anything it does not
recognise** — scripts, scenes, templates, custom integrations. `indexPendingByEntity`
(`simulation.ts:302`) makes a list read O(actions-for-that-entity) instead of O(all-actions) per row.

**GitHub goes further: provisional IDs** (`gatekeeper-github/storage-schema.md:153`). Creates
synthesize a local issue/PR object until GitHub assigns a real one; rejecting a provisional create
deletes dependent pending actions and returns `restart: true` (`github.ts:3493`).

That is the cost of simulation, made explicit. HA can reject silently because its overlay is
*derived* from `pending:*` — delete the row and the simulation evaporates. GitHub cannot: the gadget
holds a provisional number that will never exist, so the gadget must restart. Eight gatekeepers
return `{restart: true}` on some rejection path.

**The opt-out, stated plainly in both places:**

```ts
// gatekeeper-supabase/src/supabase.ts:904
// This gatekeeper doesn't simulate writes, so the agent shouldn't continue (and read back
// un-applied state) until the user decides on this statement.
awaitDecision: true,
```

```ts
// mcp-shared/src/session.ts:216
// Nothing about a queued call is simulated, so later reads would show a world in which it
// never happened. Wait for the decision instead.
awaitDecision: true,
```

Both are right: arbitrary SQL and arbitrary MCP tool calls have no predictable effect to model. MCP
additionally returns a `status: "pending"` sentinel telling the agent to return from `executeCode` so
the approval card can render.

> **Design rule if we build one:** simulate ⟺ leave `awaitDecision` unset. Getting this backwards is
> the real failure mode — a gatekeeper that neither simulates nor awaits will make agents thrash.

### 8.4 Singleton gatekeepers and ambient capsules

**The name misleads.** It is not a Durable-Object singleton. It means: *an account that provides one
always-present gatekeeper, installed into every one of the owner's gadgets automatically, with no
binding step.* The resulting object is called an **ambient capsule**.

Declared in two places (`gatekeeper-context/src/library-gatekeeper.ts:385` and `:132`):

```ts
autoProvisionsAccount: true,                    // VendorDescription — mint accounts with no OAuth
singleton: { tsType: "ContextLibrary" },        // AccountDescription — provides an ambient capsule
```

| | Ordinary gatekeeper | Singleton |
|---|---|---|
| Account created by | OAuth via `connectAccount()` | `createAccount()` — no flow, no user identity |
| Class obtained from | `getGatekeeperClassFor(url)` (user pastes a URL) | `getSingletonGatekeeperClass()` |
| Enters a gadget via | Explicit binding, user-named | `ensureAmbientCapsules()` on `open()`, **unnamed** record, `creationSpec: {type:"ambient"}` |
| Agent sees it as | A named binding in `env` | Auto-provided capsule, named at chat-seed time from `describe().suggestedBindingName` |
| `getSupportedResources()` | Non-empty | `[]` — an empty list hides the vendor entirely |
| `reconnect()` | Re-runs OAuth | Throws |
| Scope | One resource | Broad — hence `getAgentCatalog()` |
| Count | Many per workspace | One per user |

**Everything else is identical.** `ContextGatekeeper` is a plain `DurableObject implements
Gatekeeper<LibraryReadSession>` installed as a facet like any other, with the same ApprovalQueue and
the same per-read `authorizeObservation`. The contract says so outright (`gatekeeper.ts:651`):

> Because it is a normal Gatekeeper, the session and catalog run gadget-side in the gatekeeper's own
> worker with no round-trip back through this account DO; every read is still authorized as an
> observation via the ApprovalQueue, exactly like any gatekeeper.

**Provisioning is a reconciliation, not a one-shot install** (`overseer.ts:4529`), run on every
workspace open:

```ts
let accounts = (await ownerDo.listProvidedAccounts())
    .filter(account => account.description.singleton?.tsType);

// Records key on (vendorId, accountId). If the account is gone, or was removed and re-added with a
// new accountId, the record points at a deleted account — drop it.
for (let gk of existingGatekeepers) {
  if (gk.creationSpec?.type !== "ambient") continue;
  if (currentAccountId.get(gk.creationSpec.vendorId) === gk.creationSpec.accountId) bound.add(...);
  else this.removeGatekeeper(gk.id);
}
```

Two properties worth copying: provisioning is **per-account isolated** in a `try/catch` (one
gatekeeper whose `getSingletonGatekeeperClass` throws must not block `open()` for the whole
workspace), and it runs under `Promise.all` so Cap'n Web batches the class lookups.

The encapsulation note at `overseer.ts:4557` is the important one: **only the class reference crosses
out of the owner's user DO.** The account capability itself never leaves.

**Broad scope forces more observer machinery.** `addObserver` cannot be the usual "can this user read
the resource?" check, so Context tracks the collections actually revealed and verifies every observer
against each one (`library-gatekeeper.ts:201`, `:343`). Note `GatekeeperUserVerifier` has **no
methods** in the contract (`gatekeeper.ts:689`) — the convention is to add a non-standard method and
trust the answer, because the overseer only ever hands a verifier back to the vendor that minted it.

**Minimal reference implementation:**
`cloudflare-os/packages/integration-tests/fixtures/gatekeeper-test/src/test-gatekeeper.ts` — ~200
lines covering vendor, account, verifier and gatekeeper, with `singleton` and no `providesUi`.

### 8.5 Management UIs (`providesUi`)

**`providesUi` and `singleton` are independent.** Two separate optional fields on the same type
(`gatekeeper.ts:170-181`); neither implies the other. The listing gate is an **OR**, over *all*
connected accounts, with no `autoProvisioned` requirement in the inclusion test
(`workshop-backend/src/user.ts:1336`):

```ts
for (let rec of this.#connectedAccountRecords()) {
  if (!rec.description.singleton && !rec.description.providesUi) continue;
  if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
  ...
}
```

All four combinations are structurally legal:

| `singleton` | `providesUi` | Example |
|---|---|---|
| ✓ | ✓ | Context Library (`library-gatekeeper.ts:132-136`) |
| ✓ | ✗ | the integration-test fixture (`test-gatekeeper.ts:141`) |
| ✗ | ✓ | nothing ships this, but it is supported |
| ✗ | ✗ | every ordinary OAuth gatekeeper |

**The real constraint is routing, not the flags.** The app id is the **vendorId**, not the account id
(`workshop-backend/src/server.ts:558`):

```ts
// UI-providing accounts are auto-provisioned singletons (one per vendor), so the vendor id
// identifies them.
let app = accounts.find(a => a.vendorId === id && a.description.providesUi);
```

`find` — first match wins, so a vendor with several UI-declaring accounts would have all but one
unreachable at `/gatekeepers/<vendorId>`. That is why the contract comment (`gatekeeper.ts:645`) says
these methods are "Present only on accounts created by `GatekeeperVendor.createAccount()`": one
account per vendor per user is what makes vendor-id routing sound. A latent assumption, not an
enforced check.

> **Upshot: `providesUi` needs `autoProvisionsAccount`, not `singleton`.** A UI-only gatekeeper — an
> invoices page with no agent surface at all — is a legal and clean configuration.

#### The UI calls the gatekeeper directly

`startAppUi` returns an **arbitrary gatekeeper-defined capability** (`gatekeeper.ts:414`):

```ts
export type GatekeeperUiFrame = {
  iframeHtml: string;
  ui: RpcStub<RpcTarget>;   // "Capability exposed to the iframe for any RPCs needed by the UI."
}
```

Context mints it inside the account (`library-gatekeeper.ts:145`):

```ts
async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
  let ui = new RpcStub(new ContextApiImpl(
    this.env, this.ctx.props.sharingDomain, this.ctx.props.accountId, context.isAdmin,
    this.#collections(), this.#userLibraries(), this.#registries()));
  return { iframeHtml: APP_HTML, ui };
}
```

`ContextApiImpl` holds the DO namespaces directly. **There is no Overseer, no facet, no gadget, no
`ApprovalQueue` and no `ObservationAuthorizer` anywhere in this path.** The same gatekeeper exposes
two very different surfaces:

| | Agent / gadget path | App UI path |
|---|---|---|
| Entry | `ContextGatekeeper.startSession(approvalQueue)` | `ContextAccount.startAppUi(context)` |
| Runs as | DO Facet under the Overseer | plain `RpcTarget` in the gatekeeper's worker |
| Every read | `authorizeObservation()` → audit row | nothing |
| Every write | `submitAction()` → approval queue | executed immediately |
| Operations | `search` / `list` / `read` | `createContextCollection`, `putContextDocument`, `deleteContextDocument`, `moveContextDocument`, `deleteContextCollection`, git-token create/revoke, … |

The agent gets a read-only session that logs everything; the human gets full CRUD that logs nothing.
That asymmetry is deliberate: **the approval queue governs the agent acting on your behalf, not you
acting with your own hands.** Prompting for approval of your own clicks would be nonsense.

**Transport.** `getGatekeeperApp` → `GatekeeperAppPage` → `SandboxedGatekeeperApp`:
`sandbox="allow-scripts allow-modals"` (no `allow-same-origin` → null origin, network-isolated), and
capnweb `newMessagePortRpcSession(port, host)`. Workshop relays `ui` through a rate limiter rather
than handing it over raw (`SandboxedGatekeeperApp.tsx:105`): `maxConcurrency: 8`,
`maxCallsPerMinute: 600`, `maxPendingCalls: 128`, throttle. The stub is a live server-side capability,
released on unmount via `disposeFrame`.

#### Four consequences to design around

1. **We own authorization completely.** Nothing upstream checks anything beyond "this user holds this
   account." Context does its own: `#assertCanRead` / `#assertCanWrite` / `#assertAdmin`
   (`context-api.ts:89-116`).
2. **The only identity signal is `isAdmin`** — no user id, no email (`AppUiContext`,
   `gatekeeper.ts:85`), passed fresh per open precisely because admin status changes. Per-user
   scoping must come from the account's own props, as Context does with `accountId`.
3. **Nothing in this path is audited.** Deleting a collection through the UI leaves no trace in the
   workspace action log. An audit trail for the human path is ours to build.
4. **The `ui` surface *is* the attack surface.** The iframe cannot reach the network; the capability
   is its only exit. Mint the narrowest object that works, never an internal API.

Same mechanism, incidentally, as the small connect-modal form: `ResourceConfiguratorFrame` is a
literal alias for `GatekeeperUiFrame` (`gatekeeper.ts:426`).

### 8.6 Packaging note

**`workshop-shared` is a member of *this* repo's pnpm workspace** (with `error-reporting`), which is
what lets `packages/custom-gatekeeper` import the contract via a plain `workspace:*` dependency with
no submodule changes. Catalog entries in `pnpm-workspace.yaml` must stay byte-identical to the
submodule's — drift gives the tree two copies of `capnweb`, and a stub minted by one is
unserialisable by the other.

---

## 9. Gatekeeper survey

### 9.1 Anatomy, via Slack

`getTypeScriptTypes()` returns a bundled `types.txt` — heavily commented TypeScript declarations that
become **the agent's documentation** for the API. That file is the product surface.

The central pattern is **resources ↔ scopes**:

```
WORKSPACE     https://*                                               → team:read, channels:*, groups:*, im:*, mpim:*, search:read
CONVERSATION  https://app.slack.com/client/:teamId/:conversationId    → channels:*, groups:*, im:*, mpim:*, search:read
THREAD        https://*.slack.com/archives/:conversationId/:messageId → *:history only
```

- `resourceUrlPatternsToScopes()` requests only the scopes for what is being granted
- `grantedResourcesFromScopes()` exposes a resource only when **every** required scope was granted —
  a partial grant hides it rather than half-working

Slack is **read-only** (no `chat:write` anywhere). Its agent API is three interfaces —
`SlackWorkspaceSession`, `SlackConversation`, `SlackThread` — with all listings returning
forward-only `Cursor<T>`.

### 9.2 `gatekeeper-mcp` vs `gatekeeper-mcp-portal`

| | `gatekeeper-mcp` (ours) | `gatekeeper-mcp-portal` |
|---|---|---|
| Server URL | **Each user types one** | **Admin sets one** (`MCP_PORTAL_URL`) |
| Scope | Per-user | Per-deployment |
| Unconfigured | n/a | Advertises no resources → Workshop hides it |
| Trust | *"A user-supplied endpoint vouches only for itself"* | Behind Access + Gateway |

Both gate writes: `readOnlyHint` on each MCP tool decides observation vs approval-gated action. In
`gatekeeper-mcp`, tool annotations **never** earn auto-approval, precisely because the user supplied
the endpoint.

The portal's config validation is a good pattern: HTTPS-only, `hash` stripped, and **URL userinfo
rejected outright** rather than silently stripped, since silently stripping would contact a
different endpoint than the administrator configured.

### 9.3 `gatekeeper-cloudflare`

Three capabilities: **sign-in** (`providesAuth: true`); **AI Gateway BYOK billing** via
`CloudflareGatekeeperUser.getUsableAccessToken()` — a contract extension marked *"Workshop-only —
never exposed to gadgets or agents"*; and **Workers Observability** (account-level and per-Worker
logs, invocations, traces, metrics).

That last one would let an agent inspect this deployment's own Worker logs — worth considering while
the Error Reporter is disabled.

### 9.4 Building `gatekeeper-basecamp5` or `gatekeeper-telegram`

**Basecamp 5 maps cleanly.** Real OAuth 2, and unusually regular URLs
(`https://3.basecamp.com/:accountId/buckets/:projectId/...`) that fit the resource-pattern model.
Its uniform "Recording" abstraction suits `resolveRequestedResource`. Two things to plan for:
Basecamp's OAuth is **coarse** — effectively all-or-nothing per account — so
`grantedResourcesFromScopes()` has nothing to filter on and granularity must be enforced *inside* the
Gatekeeper; and it is read+write, so mutations must be `ActionDescription`s behind the approval
queue.

**Telegram is a design problem first.** The Bot API uses a bot token, not OAuth, so `connectAccount`
resembles MCP's connect form. More seriously it is **update-driven**: there is no "fetch this
channel's history" call, and group privacy mode limits a bot to messages addressed to it. A
Slack-style `listMessages()` over past conversation has no equivalent — either the Gatekeeper
durably accumulates messages from the moment it connects, or the design moves to MTProto with a real
user account. Inbound delivery is where `HookController`/`HookInitiator` and
`external-message-gateway.ts` come in. Scope the history question before writing code.


### 9.5 `gatekeeper-email` — the Gatekeeper that *is* the service

Structurally the odd one out, and the most instructive for anything we build on Cloudflare
primitives. Every other Gatekeeper is a **client** of an external API. This one is a **server**: mail
from the public internet enters the platform through it.

#### Two entry points

`src/email.ts:161` — the default export carries a second handler:

```ts
export default {
  async fetch(req, env, ctx)  { ... },   // connect-flow completion URL only
  async email(message, env, ctx) { ... } // inbound SMTP, via Cloudflare Email Routing
};
```

The router carries a matching one (`packages/router/src/index.ts:62`):

```ts
async email(message, env) {
  if (!env.GATEKEEPER_EMAIL) {
    message.setReject("No email gatekeeper is installed on this instance.");
    return;
  }
  await env.GATEKEEPER_EMAIL.email(message);
}
```

with `GATEKEEPER_EMAIL?: Service<EmailEntrypoint>` marked *"Dormant until custom domains + Email
Routing exist; the handler ships anyway."* Email Routing may target either worker; pointing it at the
router keeps one worker owning the origin.

#### No OAuth, no credentials

There is no third party to authorize against, so `connectAccount` (`email.ts:274`) mints a nonce URL
served by its *own* `fetch()`, and clicking it **is** the authorization. All the security is in the
nonce: 32 bytes, `crypto.subtle.timingSafeEqual`, 10-minute expiry, and a 1-hour self-destruct alarm
on the `UserAccount` DO if the flow is abandoned. Nothing expires afterwards; `reconnect()` throws.

#### The namespace problem — the transferable part

Owning the service means owning a **global namespace** (mailbox local parts) that no external system
arbitrates. The solution: **the DO name *is* the address.**

```ts
let stub = ctx.exports.EmailAddress.getByName(name);   // local part → DO
```

Uniqueness comes free from Durable Object naming. Ownership is then one KV key (`email.ts:626`):

```ts
async claim(userAccountId: string): Promise<boolean> {
  let owner = this.ctx.storage.kv.get<string>("owner");
  if (owner && owner !== userAccountId) throw new Error("This email address is claimed by another user");
  if (!owner) { this.ctx.storage.kv.put("owner", userAccountId); return true; }
  return false;   // idempotent for the same owner
}
```

Three details make it correct rather than merely working:

- **Claims are permanent.** `revoke()` disconnects every hook but explicitly does *not* release
  claims — `// ... they are permanent.` Right call: releasing an address would let a later user
  receive mail intended for an earlier one.
- **Two-phase with conditional rollback** (`email.ts:427`) — `EmailAddress` is the source of truth,
  `UserAccount` the index, and the compensation is gated on `newlyClaimed` so a retry cannot release
  a pre-existing claim:
  ```ts
  let newlyClaimed = await emailAddress.claim(userAccountId);
  try { await userAccount.addEmail(emailName); }
  catch (error) { if (newlyClaimed) await emailAddress.releaseClaimAndHook(userAccountId); throw error; }
  ```
- **Canonicalization enforced twice** — `validateEmailName` lowercases and regex-checks, then the URL
  is re-encoded and compared: `if (emailNameSegment !== encodeURIComponent(validated.emailName)) throw`.
  Without that second check, `Foo`, `foo` and `%66oo` would be three URLs claiming one mailbox.

> **Generalizable:** any Gatekeeper that *is* the service inherits a namespace-allocation problem the
> client-style ones never face. A Basecamp or Telegram Gatekeeper is a client and skips this
> entirely; a media, webhook-receiver or SMS Gatekeeper inherits it in full.

#### The canonical hook implementation

`SKILL.md:301` names it outright: *"`gatekeeper-email` is the canonical reference implementation"*
for hooks. Seen from the Gatekeeper side, the loop from [§8.2](#82-sessions-and-the-approvalqueue) is:

1. **Register** — `subscribe(callback)` (`email.ts:506`) builds the controller *at bind time* so its
   props capture this registration, then hands both to the overseer. It never stores the callback.
2. **Enable** — `controller.enable(initiator, _target)` → initiator persisted in the `EmailAddress`
   DO under `"hook"`. `_target` is unused but **must** be declared: RPC argument validation is
   generated from the signature and rejects undeclared arguments.
3. **Deliver** — `receiveEmail` (`email.ts:661`) is worth reading closely:
   ```ts
   using startHookResult = hookInitiator.startHook();     // no await
   await startHookResult.approvalQueue.authorizeObservation({ ... });
   await startHookResult.callback.receiveEmail(email);
   ```
   That is **promise pipelining** — a property access on an unresolved promise, collapsed by Cap'n
   Web into one round trip. `using` disposes the result and every stub inside it.
4. **Disable** — `#setHook(null)`.

`startSession` calls `approvalQueue.dup()`, per the SKILL tip: Cap'n Web auto-disposes stubs passed
as RPC parameters when the call returns, so anything outliving the call must be duplicated.

#### Observers: "strategy D", and why it is legitimate *here*

`addObserver` / `removeObserver` are no-ops and `EmailVerifier.verify()` is empty. The justification
(`email.ts:578`):

> Each mailbox is a fresh address minted on the deployment's own domain for this Gadget; there is no
> external ACL and no other party who "independently has access" to that inbox, so the Gadget's own
> collaborators are the natural audience.

**That reasoning is available only because it is the service.** A Gmail Gatekeeper must use strategy
A (always throw) — a real personal inbox can never be shared. Here the inbox was conjured for the
gadget, so gadget collaborators *are* the correct ACL.

Every inbound email is logged as an observation carrying **sender, subject, date, to, cc — but not
the body or attachments**, which go straight to the gadget. The audit log records *that* mail arrived
and from whom, never its content.

#### Receive-only, and two sharp edges

`applyAction` throws, `rejectAction` no-ops, `revertAction` throws, `getAutoApprovableActions()`
returns `[]`. Nothing is ever submitted to the queue.

- **`SupportedResource.description` says "Send and receive emails."** There is no send path anywhere
  in the package. An agent reading the resource catalog could reasonably believe outbound mail works.
- **Unbound mailboxes bounce, and leak the error.** `receiveEmail` throws when no hook is configured,
  and the handler calls `message.setReject("Delivery failed: " + err)` — bouncing is right, but the
  raw error text reaches the sender.

#### Deployability for `os.veer.studio`

It ships in every release but is excluded from the hosted deploy app
(`scripts/release/manifest-lib.ts:260`):

```ts
// Not installable on customer instances: Email Routing needs a zone, which workers.dev-hosted
// instances don't have. The bundle still ships in the release so the entry stays auditable.
const NOT_INSTALLABLE = new Set(["gatekeeper-email"]);
```

**That blocker does not apply to us** — `veer.studio` is a real zone with the router already on it.
But it is also absent from this wrapper's `packageDirs` (`scripts/deploy.ts:22-30`), so wiring it
needs the same treatment MCP got: a `packageDirs` entry, `workers.email.name`, an `email.enabled`
flag, `GATEKEEPER_EMAIL` in the router's service list, a build command, and `BASE_URL`.

`BASE_URL` matters more here than for MCP. It is simultaneously the resource-URL namespace *and* the
fetch-handler path prefix, and `getGatekeeperClassFor` rejects any URL whose origin does not match.
Left unset it falls back to `http://localhost:8787/gatekeeper/email` and **no mailbox can ever be
bound** — a harder failure than MCP's broken callback.

One further gotcha, admitted in the source (`email.ts:88`):

```ts
// TODO: This is actually a lie, as email routing can be configured on an entirely different
//   domain and forwarded to this worker. We only really care about the name before the `@`...
function getEmailHost(env: Env) { return new URL(getBaseUrl(env)).hostname; }
```

With `BASE_URL=https://os.veer.studio/gatekeeper/email` and routing on `*@veer.studio`,
`getAddress()` reports `foo@os.veer.studio` while the working address is `foo@veer.studio`. Routing
still succeeds (only the local part is used), but every address shown to the UI and the agent is
wrong.

---

## 10. Credentials and secrets

**Gadgets cannot hold secrets.** There is no gadget secret store and no API to set one. A gadget
holds a *binding* to a Gatekeeper that holds the credential.

| Layer | Mechanism |
|---|---|
| Deployment secrets | Wrangler secrets on the **consuming Worker** (e.g. `CLIENT_SECRET` on the gatekeeper Worker, never the backend) |
| User OAuth tokens | The Gatekeeper's own DO (Slack's `UserAccount`) |
| Delegated tokens | **Minted, not stored** — Context git tokens come from `repo.createToken("write", TTL)`; the Gatekeeper never holds them |
| Privileged reads | Marked explicitly — `getUsableAccessToken()` is Workshop-only; `user.ts:694` carries `/** DO NOT MAKE PUBLIC -- returns API keys. */` |

Two implementation details worth copying:

- Slack serializes credential mutations through a promise chain because *"rotating refresh tokens are
  single-use"* — concurrent refresh/revoke against a rotating token is a real corruption bug.
- `listGitTokens` filters to **write** tokens only; the DO mints its own read tokens for cloning and
  deliberately does not expose them. `GIT_TOKEN_TTL_SECONDS = 31_536_000` (1 year).

### The sharp edge

Blueprints exclude credentials — enforced. But from `docs/sharing.md`, *"the full `AiModelConfig`
**including API key** is stored in the binding props"*. That key is in the **live gadget**, and
`build` collaborators can read bindings.

> **Never add a BYOK AI model binding to a gadget shared with clients.** Let each collaborator add
> their own — that is already the platform's grain, and it bills them.

### Condensed practice

1. Credentials belong to a **Gatekeeper**, never a gadget
2. Deployment secrets → Wrangler secrets on the Worker that consumes them
3. Prefer **minting short-lived scoped tokens** over storing long-lived ones
4. **Serialize** credential mutations when refresh tokens rotate
5. Sign-in should use **minimal scopes with a transient grant**
6. Treat **binding props as visible to `build` collaborators**
7. Never put a credential in `customGatekeeper.message`, a Context document, or a `SKILL.md` — all
   three are agent-readable, and Context documents are searchable

---

## 11. Design sketches

*Exploratory. Nothing built.*

### 11.1 Client portal and billing

#### The reframe

Replacing Access with a `veer-clients-gatekeeper` is feasible — identity stays keyed by verified
email, so no accounts move — but the cost is concentrated: **unauthenticated requests would start
reaching application code**, and we would inherit sessions, token rotation, recovery and MFA that
Access provides today (including one-time PIN, which already lets external clients sign in with just
an email).

**The portal does not need to be the auth mechanism.** A Gatekeeper works fine in Access mode as an
ordinary connector — only gatekeeper *sign-in* is unreachable. Keep Access as the outer door; build
the commercial layer as an ambient Gatekeeper.

#### Where the portal lives

Two independent flags on `AccountDescription` (`gatekeeper.ts:170-181`) — see [§8.5](#85-management-uis-providesui)
for the full mechanics:

```ts
singleton?: { tsType: string };                       // an ambient agent capsule
providesUi?: { title: string; icon?: AvatarImage };   // a full-page management UI
```

`providesUi` yields `startAccountAppUi(accountId, { isAdmin })` → a `GatekeeperUiFrame`: a full-page
app in a sandboxed iframe, with `isAdmin` supplied fresh per open. That is a customer-portal surface.
Mark the Gatekeeper auto-provisioned and every user gets it without connecting.

Three findings from §8.5 shape the design here:

- **The portal does not need `singleton`.** `providesUi` requires `autoProvisionsAccount` (one
  account per vendor, because routing keys on vendor id), not an agent capsule. An invoices page with
  no agent surface at all is a legal configuration — worth considering for v1.
- **The UI path bypasses the approval queue entirely.** The `ui` capability is minted inside the
  account and reaches the iframe over a MessagePort with no Overseer, no `ApprovalQueue` and no
  `ObservationAuthorizer` in between. Clients reading their own invoices get zero approval friction —
  which is what we want — but it also means **we own authorization and audit in that path
  completely.** For billing, an audit trail is not optional, and nothing upstream will write it.
- **The only identity signal is `isAdmin`** — no user id, no email. Per-client scoping has to come
  from the account's own props (`accountId`), the way Context does it.

#### The gap: no metering primitive

- `PRODUCT_ANALYTICS` is an **optional Pipeline binding, not bound** in the base config nor by this
  repo. Its events are lifecycle-shaped (`account_created`, `gadget_created`, `connection_created`,
  `user_authenticated`, …) — no per-call events, no token counts, no cost.
- **Observations are not a ledger** — they are the access-control mechanism.

Nothing counts "client X made 400 calls through gatekeeper Y." **Metering must live in our own
Gatekeepers.**

#### The reference implementation

`docs/ai-gateway-billing.md` is the shape, already in-tree:

- Per-user counters on the user's own DO — `consumeDailyLlmCall(limit)` is an atomic check-and-count
  where `withinLimits` is the *pre-count* decision and it no-ops once exhausted, so a blocked request
  never counts
- A gate before each billable action (`checkUsageAndBalance`)
- Live balance from an external billing API, cached 5 minutes
- And the design rule, stated outright: **"the platform never holds money"**

#### Proposed shape

1. **`veeros-gk-billing`** — auto-provisioned with `providesUi`; owns a `ClientAccount` DO per user
   and renders the portal. Add `singleton` only if an *agent* should be able to query balances;
   the human portal does not need it.
2. **Metering by convention** — each veer-owned Gatekeeper holds a service binding to it and calls
   `recordUsage(vendorId, unit, qty)`. The invoice is unified because all our Gatekeepers report to
   one ledger, not because the platform unified anything
3. **Invoicing** — hold no money; push line items to Stripe and render its state
4. **Enforcement** — a `checkUsageAndBalance` analogue at the top of each call

#### Constraints

- **Everything is per-user, not per-org.** No organization concept exists; "client = company with
  three seats" is a mapping we maintain.
- **"Who pays" is already opinionated** — BYOK bills whoever prompted; bindings resolve to their
  creator.
- **We can only meter our own Gatekeepers.** Context, Scheduler and MCP do not report to us without
  patching the submodule.
- **Metering sits on the trust boundary** — decide deliberately whether a failed `recordUsage`
  blocks the call or is fire-and-forget. That choice is either a revenue leak or an outage.
- **A charge cannot be honestly simulated.** Any agent-initiated billable action must set
  `awaitDecision: true` and leave `autoApprovable` unset (see [§8.3](#83-simulating-actions)). The
  human portal path is unaffected — it never touches the queue.


### 11.2 Media service on R2

*Exploratory. Nothing built. The premise — a media service built the way `gatekeeper-email` is built
— is sound, and the platform fit is unusually good.*

#### The shape: Email's posture, Context's storage

It is a hybrid of the two Gatekeepers we now understand best:

| Borrowed from | What |
|---|---|
| [`gatekeeper-email`](#95-gatekeeper-email--the-gatekeeper-that-is-the-service) | *Being* the service: owns a public HTTP surface, owns a namespace, no OAuth, claim-based ownership |
| [`gatekeeper-context`](#3-context-gatekeeper) | Collections with public/private visibility, `providesUi` file manager, ambient `singleton` for agent read |

R2 supplies durable object storage; Cloudflare Images (`/cdn-cgi/image/…`) and Stream supply the
transforms. Both require a zone — **the same constraint that makes `gatekeeper-email`
`NOT_INSTALLABLE`, and one we satisfy.**

#### Verified: no in-tree precedent for serving bytes

Every existing Gatekeeper `fetch()` handler is an OAuth callback, an MCP transport, or a status
string. Context does **not** serve git itself — the platform `ARTIFACTS` binding does, and Context
merely mints scoped credentials against it (`artifact-sync.ts:206`):

```ts
let token = await repo.createToken("read", 3600);   // short-lived, per-operation
```

So a media Gatekeeper serving public bytes would be the **first of its kind in this codebase**. The
mechanism already exists: the router forwards `/gatekeeper/<suffix>/*` to whichever `GATEKEEPER_*`
service is bound (`router/src/index.ts:27-34`), so `https://os.veer.studio/gatekeeper/media/...` needs
no router change — only a binding.

`ARTIFACTS`' short-lived scoped token is also the in-tree precedent for signed-URL minting, which
matters below.

#### Namespace and ownership

Directly transferable from email: pick the unit that needs global uniqueness (a *library* or
*bucket* name), make it the DO name so uniqueness is free, and claim it permanently.

- `MediaLibrary` DO via `getByName(libraryName)`; `claim(accountId)` first-wins, idempotent for the
  same owner, throws for a different one
- **Permanent claims** — releasing a media namespace would let a later user serve bytes from URLs an
  earlier user already published
- **Double canonicalization** — validate/normalize, then re-encode and compare, or `Foo` and `foo`
  become two claims on one library
- R2 keys live under the claimed prefix; the DO holds metadata, R2 holds bytes

#### Where simulation fits — better than most

Uploads are a rare case where [§8.3](#83-simulating-actions) simulation is both cheap and honest,
because **the expensive half is idempotent and the approval only gates visibility**:

1. `upload()` writes bytes to a **staging prefix immediately**, then `submitAction`
2. Pending uploads appear in `list()` with a provisional id — GitHub's pattern
   (`storage-schema.md:153`)
3. Approval is a **metadata flip**, not a byte copy
4. `revertAction` moves the object back to staging — genuinely reversible, so
   `implementsRevert: true`
5. No `awaitDecision` needed; the agent keeps working

Deletes get the same treatment: soft-delete on approval, revert restores. Most Gatekeepers cannot
offer real revert; this one can, which is worth exploiting rather than defaulting to
`implementsRevert: false`.

Split the surface the usual way: `list()` / `read()` / `getUrl()` are observations; `upload()` /
`delete()` / `replace()` are actions.

#### The real design risk: a public URL escapes the observation model

This deserves deciding **before** any code. A public media URL is a **capability that leaves the
system**. Once an agent obtains one and writes it into a document, anyone with the link reads the
bytes — and none of the platform's controls can reach it:

- `excludeObservers` blocks a *read through the session*, not an HTTP GET to a CDN URL
- `prohibitAllSharing` locks down the workspace, not a URL already emitted
- The audit log records that a URL was *minted*, never that it was *fetched*

This is the same class of gap as email's — where the observation description carries the subject but
never the body — but larger, because a URL is transferable and an email body is not.

Three defensible resolutions; pick explicitly:

1. **Signed, short-lived URLs minted per observation.** Follows the `ARTIFACTS` precedent
   (`createToken("read", 3600)`). Keeps the capability bounded; costs CDN cacheability.
2. **Public by design**, with the constraint written down: this is a *published-media* CDN, never a
   store for anything access-controlled. Simple and honest, and probably right for a marketing-asset
   library.
3. **Two library classes** — public and signed — with visibility a property of the library, mirroring
   Context's public/private split. Most work; most flexible.

Option 2 with option 3 as the upgrade path is the pragmatic start.

#### Observers

If libraries are minted per-deployment for a gadget, email's **strategy D** (no-op `addObserver`,
trivial verifier) is defensible on the same reasoning: no external ACL exists and the gadget's
collaborators are the intended audience. The moment media becomes *private per user*, that argument
dies and it needs Context's strategy — track which libraries were revealed, verify every observer
against each.

#### Management UI

`providesUi` with Context's file manager as the template. Per
[§8.5](#85-management-uis-providesui), that path bypasses the approval queue entirely — which is
exactly right for a human dragging files into a media library, and exactly why **we would own
authorization and audit in that path completely**.

#### Why this pairs with §11.1

Storage-GB and transform-count are **meterable units**, which most Gatekeepers do not have. A media
Gatekeeper is the natural first consumer of the `recordUsage(vendorId, unit, qty)` convention
sketched above — and the natural first test of whether a failed `recordUsage` should block the call.

#### Open questions before building

- **Transform binding**: Images binding vs. `/cdn-cgi/image/` URL-based. Neither is bound anywhere
  in-tree today; both need new wiring and a zone.
- **Upload path**: through the Worker (simple, subject to request limits) vs. R2 presigned PUT
  (scales, but the bytes never pass a point where we can validate them).
- **Video is not images**: Stream is a separate product with its own IDs, encoding latency and
  billing. Treat as a second resource type with its own `.d.ts`, per the SKILL tip.
- **Size and quota**: R2 has no per-prefix quota. Enforcement is ours, in the Gatekeeper.

---

## 12. Open items

### Decided, not yet done

- **Deploy the `54d5d8b0` bump.** The gitlink is bumped, installed and `pnpm check`-clean, but the
  live Workers still run `6478a144`. Deploying carries the one-way git-storage migration (§13.3)
  and the compatibility-date bump (§13.4), so it wants the ordinary approval + post-deploy
  verification pass, not a drive-by `pnpm deploy`.
- **Three blueprints** — message board, todo list, kanban; Basecamp-5 styled, built in-platform from
  `format.document`, promoted via `/admin` → Formats (path A). Read the extracted `server.js` first
  to decide whether to inherit its `document:v2` revision model.
- **Context collection** — a git-backed house knowledge base, `public` visibility so it is
  admin-write / everyone-read, with `skills/<name>/SKILL.md` folders.

### Deferred

- `FORMAT_BLUEPRINTS_DIR` wiring into `buildCommands()` (path B), if bundling is wanted later
- Custom Gatekeeper and Error Reporter — code retained, disabled
- `veeros-gk-billing` scaffold — auto-provisioned Gatekeeper with `providesUi` and a stub portal
- `veeros-gk-media` — R2 + Images/Stream, built on the `gatekeeper-email` "is the service" pattern
  (§11.2). Decide the public-URL question before writing code.
- `gatekeeper-email` — shipped upstream but absent from `packageDirs`; installable for us because we
  hold a zone. Needs `BASE_URL`, a `GATEKEEPER_EMAIL` router binding, and Email Routing DNS.
- `gatekeeper-basecamp5`
- Connecting `gatekeeper-cloudflare` for Workers Observability

### Watch

- **Node 24.15.0 < declared `>=24.19.0`** — warning only today
- **`README.md` says "The deployment is six Workers"** — stale; the count is now configurable
- **Any future OAuth Gatekeeper needs `BASE_URL`** — nothing enforces it
- **`blueprintId` is an install key** — never rename after deploy
- **Upstream `enableHook` / `disableHook` race** (`overseer.ts:2697`, `enableHookRecord`, at pin
  `54d5d8b0`) — a losing `enable()` can
  resurrect gatekeeper-side state that keeps consuming alarms and quota. Relevant only once we run a
  hook-driven Gatekeeper of our own.
- **`providesUi` routing keys on vendor id, not account id** (`server.ts:580`) — one UI-declaring
  account per vendor per user, or the extras become unreachable
- **Upgrades**: keep `pnpm-workspace.yaml` catalog entries byte-identical to the submodule's — and
  expect submodule workspace *reshapes* too, not just version drift (§13.1: a new member to add and
  a test filter to widen)
- **The next storage migration will not be free.** §13.3's rollback-is-gone tradeoff was acceptable
  only because no gadget history existed. Once real gadgets do, a migrating bump needs a parallel
  Workshop identity with its own storage, exercised against a copy, before it touches production.
- **`gitObjects` has no GC and a soft ~2MB per-object ceiling** (§14.1) — neither enforced. Worth a
  look at actual object counts once gadgets accumulate history.
- **`scratchpad/extract-gadget.mjs` is obsolete** for built-ins (§4.2); it still applies to
  `.gadget` files exported from `/admin`.

---

## 13. Upgrade log: `6478a144` → `54d5d8b0`

Bumped 2026-09-09. 82 commits, 2026-08-18 → 2026-09-08. The old pin is a strict ancestor of
`origin/main`, so this was a clean fast-forward with no divergence to reconcile. The starter wrapper
itself needed nothing from `cloudflare/cloudflare-os-starter` — our `main` was already level with
upstream's.

### 13.1 What the wrapper had to change

Three edits, all forced by upstream repackaging rather than by anything we chose:

1. **`pnpm-workspace.yaml` catalog mirror.** Bumped to match the submodule byte-for-byte:
   `@cloudflare/vitest-pool-workers` `^0.20.2` → `^0.22.0`, `capnweb` `^0.11.1` → `^0.12.0`,
   `capnweb-validate` `0.2.4` → `0.3.0`, `wrangler` `^4.119.0` → `^4.128.0`, plus a new
   `@cloudflare/workers-types` `^5.20260903.1` entry (`workshop-shared` now declares it as
   `catalog:`, and that specifier resolves in *our* workspace because `workshop-shared` is a member
   of it). Also mirrored the two new `@cloudflare/vitest-pool-workers>miniflare` /
   `>wrangler` overrides, which keep the test pool's workerd aligned with the toolchain.

2. **`cloudflare-os/scripts` added as a workspace member.** Upstream #431 turned the shared build
   tooling into a real package, `@gadgets/scripts`, and `cloudflare-os/packages/error-reporting` —
   one of the two submodule packages we pull into *our* workspace — now declares it as a
   `workspace:*` devDependency. A `workspace:*` specifier only resolves against the workspace that
   owns the member, so without the entry `pnpm install` fails outright with
   `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. Adding it is the fix; we never build or import it.

3. **`package.json` test filter.** Adding that member pulled it into
   `vp run --filter '!cloudflare-os-starter' --cache test`, and its `test` task shells out to
   `gadgets-with-timeout` — its own bin, not linked into its own `.bin` — so the run died with
   `Failed to find executable gadgets-with-timeout`. That suite is upstream's workspace-wide CI
   guard (it walks `packages/…` from the *submodule* root); it belongs to
   `pnpm --dir cloudflare-os test`, not to ours. Excluded with a second
   `--filter '!@gadgets/scripts'`.

None of these are optional and none are reversible by config — expect the same three classes of
breakage on future bumps, since all three follow from the submodule reshaping its own workspace.

### 13.2 What the wrapper did *not* have to change

`scripts/deploy.ts` survived untouched. Every anchor it reaches into still exists at the new pin,
and the two files it imports by relative path — `cloudflare-os/scripts/pnpm-command.ts` and
`bin-entry.ts` — are byte-identical across the range. The build task names it drives
(`build:app` on `gatekeeper-context` and `gatekeeper-scheduler`, `build` on `gatekeeper-mcp`) are
unchanged, as is `resolveAiGateway()` in `scripts/preview/staging-config.ts`, which
`deploy.ts` mirrors. `pnpm check` passes: wrapper tests green, all six Workers dry-run clean,
generated `wrangler.prod.jsonc` files removed afterward.

Package inventory gained two and lost none: `gatekeeper-kit` (a **library**, explicitly "not a
deployable Worker" — the connect-flow, credential, action, observation and simulation primitives
the gatekeepers now share) and `workshop-evals`. Nothing `deployment.jsonc` names changed identity,
so the Worker names, storage bindings and Access configuration all carry over as-is.

### 13.3 The one-way migration

**This is the only part of the bump that is not reversible.** Upstream #275 moved mainline gadget
code out of the workspace-wide Yjs update log and into real git commits (§14).
`workshop-backend/src/git-migration.ts` converts an existing workspace on the way: it replays the
legacy `code`/`snapshots` log once, synthesizes a chain of real commits per gadget, and rewrites
every record that referenced a code-log version to reference a commit instead — gadget heads
(`GadgetRecord.commitId`), historical `merge` messages, and blueprint records
(`codeVersion` → `commitId`).

Operationally, three things matter:

- **It runs itself.** The migration fires in the Overseer DO constructor under
  `blockConcurrencyWhile`, gated by the `version` singleton (`overseer.ts:1925`,
  `#migrateToGitStorage` at `overseer.ts:1973`) — i.e. on the first request after the Workshop
  deploy, not from a command anyone runs. There is no dry-run and no opt-out.
- **It is safe to crash.** Object writes are content-addressed (recommitting identical history
  yields identical oids), record rewrites are deterministic from storage state, and all of them
  land in one synchronous tail. A crashed run is simply redone; a chat that already has a
  `codeBase` is skipped as already-converted.
- **It is not reversible.** Pre-conversion chat messages keep their retired Yjs `update` bytes on
  disk "as rollback insurance, but nothing can apply them" — delivery strips them. Rolling the
  Workshop Worker back to `6478a144` afterward would leave the old code reading a converted store.
  The old `code`/`snapshots` collections are kept read-only for a transition period; upstream
  intends to delete them in a later change.

We accepted this deliberately: nothing of consequence has been built in the Workshop yet, so
there is no gadget history worth protecting. **That judgement expires the moment real gadgets
exist.** The next bump that carries a storage migration needs the full treatment — a parallel
Workshop identity with its own storage, exercised against a copy — because a rollback will no
longer be available as a safety net.

Context storage changed format too (`Uint8Array` instead of JS strings, #274) but is
backward-compatible on read: `decodeStoredContextBody` accepts `string | Uint8Array`, so
pre-existing rows still decode. No migration, nothing to approve.

### 13.4 Compatibility-date bump

Every Worker moved from `2026-02-02` (`2025-11-01` for the router) to `2026-09-04`, and
`workshop-backend` dropped the `enhanced_error_serialization` flag. This is a runtime behaviour
change independent of any code in this repo, and it lands with the same deploy. Nothing in our
configuration pins a compatibility date, so there is no local override to reconcile — but it is
the reason a post-deploy verification pass matters more than usual on this bump.

### 13.5 Everything else, by theme

- **Gatekeeper platform** — `gatekeeper-kit` bootstrap and leaf modules; replayable runs, declared
  action fences and a conformance consumer (#460); pending-action file storage; a preview-OAuth
  helper. Relevant to §8: the contract we documented is now partly *library*, not just convention.
- **Git and remotes** — worktrees, the `GitCache` layer, and the GitHub gatekeeper's real
  smart-HTTP transport (§14).
- **Google** — Drive gatekeeper foundation, native document sessions, metadata search, multi-tab
  Docs, Calendar primary-alias resolution and batching guidance, configurator token refresh.
  Enhanced Gmail support (#367).
- **Observer verification** — coverage bookkeeping fixes and session restart when scope widens
  (#380). Touches §8.2's account of observer registration.
- **Models** — GLM 5.3 Flash, DeepSeek V4 Pro 0813, pi 0.84.3.
- **Frontend** — chat composer extracted and hardened, a skill picker with composer pills, mobile
  and responsive work, IME composition guards, several layout fixes.
- **Blueprints** — built-ins unpacked from `.gadget` archives into reviewable source trees (§4.2).

---

## 14. Git-backed code storage and worktrees

New at pin `54d5d8b0` (upstream #275 for the store, #384 for the remote flows). This replaces the
Yjs-log account of mainline code that §3 and §4 were written against. The plans upstream wrote for
both are checked in and worth reading directly: `cloudflare-os/plans/git-storage.md` and
`cloudflare-os/plans/worktrees.md`.

### 14.1 One store per workspace, not one repo per gadget

The natural guess — each gadget gets its own repo — is wrong, and the design says so explicitly.
There is **one git object store per workspace**, held in that workspace's Overseer DO, with every
gadget's history mixed together in it. From `git-store.ts`:

> Each workspace's Overseer DO holds a real git object database — SHA-1, zlib-deflated loose
> objects, byte-identical to what `git` itself would write — stored in the `gitObjects`
> typed-storage collection.

Gadgets are separated by *history*, not by *storage*: each gadget record points at its own head
commit (`GadgetRecord.commitId`, `overseer.ts:359`) and its own parent chain, and unrelated DAGs
coexist without interfering because the store is content-addressed. Sharing the store is the point,
not an accident — gadgets forked from each other, or instantiated from the same blueprint,
deduplicate at the blob and tree level for free.

The format is genuinely git, not git-shaped. isomorphic-git supplies the object codec, and only its
plumbing is used — `writeBlob`/`writeTree`/`writeCommit`/`read*`/`log`, against a gitdir containing
nothing but `objects/**`. The porcelain is off-limits by decision: `git.commit` hard-requires
HEAD/index/config, and `git.merge` cannot express the merge behaviour the workspace wants. Upstream
chose real formats specifically so that code could later be exported to and imported from real
repositories, and so agents could mount arbitrary repos through gatekeeper-gated push/pull — which
is exactly what §14.4 turned out to be.

Storage properties worth knowing before we build anything large on it:

- **Loose objects only**, one storage record per object, keyed by oid. isomorphic-git never writes
  deltified data, so each record is a zlib'd whole object. Dedup comes from content addressing, not
  deltas.
- **No object exceeds ~2MB today** and nothing enforces that — records hold single source files,
  small trees and commit headers. Chunking records or spilling large blobs to R2 is noted as a
  later change local to the fs shim.
- **No GC.** Dangling objects come only from accepted merges, imports and migration — never from
  in-flight chats — and are considered cheap. The roots are enumerable if GC is ever needed.
- **Commit identity is the real user profile ID**, typically an email; bare usernames (from
  username/password mode) become `<username>@localhost` as a placeholder until commit identity is
  customisable.

### 14.2 What is *not* involved: Artifacts, R2, refs

**Cloudflare Artifacts is not what backs this**, though the guess is a fair one — Artifacts is a
real Cloudflare product ("Git-compatible file storage on Cloudflare Workers"), and this deployment
already uses it. Upstream never writes down a rejection, so what follows is the constraint set,
not a quoted decision.

*What Artifacts actually is here.* A Workers binding whose entire surface is a **control plane**:
`create`, `get`, `import`, `list`, `delete`, and on a repo handle `createToken`, `listTokens`,
`revokeToken`, `fork`. There is no object or file read/write on the binding at all. Content is
reached the ordinary way — mint a scoped token, then speak git over HTTPS. That is exactly what
`gatekeeper-context/src/artifact-sync.ts` does for Context collections: `repo.createToken("read",
3600)`, clone over `isomorphic-git/http/web` with the token as HTTP basic auth, revoke the token
afterward. Our `context.artifacts` block in `deployment.jsonc` generates a first-class
`artifacts` wrangler binding (`ARTIFACTS`, namespace `veeros-context-collections`) — not a KV
namespace; `kvNamespaceId` / `CONTEXT_COLLECTIONS` is the separate one.

*The decisive constraint is availability, and it is stated outright* — in
`scripts/release/manifest-lib.ts:251`, of all places:

> gatekeeper-context's Artifacts binding is closed-beta and cannot be provisioned in arbitrary
> user accounts; it is dropped from customer manifests (the gatekeeper degrades gracefully).

The release manifest *cuts* the binding for customer instances, and `ARTIFACTS_CUT_ALLOWED`
(`:256`) hard-fails the build if any package other than `gatekeeper-context` declares one:
*"only gatekeeper-context's is known (and cut). Decide how customer instances should handle this
one."* Context can survive the cut because git-backed collections are an optional feature that
degrades to unavailable. A Workshop whose **entire code storage** were Artifacts could not degrade
at all — it would simply not run in most accounts. That alone rules it out for the kernel,
independent of any design preference.

*The structural mismatch points the same way* (this part is inference from the API surface, not
upstream's words). The store is read on the hot path — every `readFile`, every tree walk, every
`isAncestor` step — and Artifacts offers no way to read one object. Reaching it means a token and
a git fetch, i.e. the Overseer DO leaving the isolate to speak a wire protocol to fetch bytes it
would otherwise read straight out of its own storage. It also mints *repositories*, which is the
per-gadget-repo model §14.1 explicitly rejected, and it carries a ref layer the workspace
deliberately does not want (see below). And a write token is a credential to store, rotate and
revoke — the Context Gatekeeper's handling of exactly that is why `deployment.jsonc` warns that
Artifacts repository write tokens are credentials.

Where Artifacts *would* fit is the direction upstream actually gestures at: the store uses real git
formats specifically so code can later be exported to and imported from real repositories, and
`Artifacts.import()` takes an HTTPS git remote. An "export this gadget to a repo" path is a
plausible future use. Nothing implements it today.

**R2 is not involved either.** The objects live in the Overseer DO's own storage via the
`gitObjects` typed-storage collection — the same SQLite-backed storage that holds gadget records
and chats. Our `veeros-blueprint-content` R2 bucket is unaffected. (R2 is named in the design only
as a *possible future* spill target if objects ever exceed ~2MB.)

**There is deliberately no ref layer.** No branches, no tags, no HEAD. The store is objects only.
What plays the role of refs is the workspace's own records: gadget records, blueprint records, and
chats' pinned commits — all managed by the Overseer's workflow. A gatekeeper that wants branch and
tag semantics has to provide them in its own API, which is exactly what the GitHub gatekeeper does
(§14.6). Being refless is what lets unrelated histories share one store safely.

### 14.3 The merge model: the chat is the branch

The rule is short and worth internalising, because it governs what the agent can and cannot do to
mainline:

- **Committing to mainline is only ever a fast-forward.** Accept requires that the chat has already
  merged the gadget's head commit, and then creates a plain commit on top of head.
- **If mainline moved, you update the chat, not mainline.** A 3-way merge (diff3) of
  merged-head / head / chat trees is computed and delivered *into the chat*, advancing the chat's
  merged commit. Conflicts are left inline as ordinary 3-way conflict markers for the user or their
  agent to clean up, and then accept is retried.
- **Yjs is now only the representation of uncommitted changes within a chat.** CRDT merge across
  divergent bases produces nonsense, so it is explicitly not used for cross-base merging; conflict
  markers are considered better.
- **Standalone out-of-chat mainline editing is removed.** Editing happens only within chats.
  (Upstream notes a future agent-less chat as the path back to manual edits.)

So: the chat *is* the branch, mainline only ever advances by simple commits, and the whole design
is laid out to allow multi-commit chat sessions later without changing the mainline rule.

### 14.4 Worktrees — mounting a remote commit

A **worktree** is a new kind of workpiece: a file tree rooted at a git commit, which the agent reads
and edits with its ordinary file tools, but which has **no runnable code** — you cannot execute a
worktree as a gadget. This is the "mount an arbitrary repo" capability the store was built for.

Structurally it reuses everything: worktrees live in the same `gadgets` collection, now generalised
to a `WorkpieceRecord` with a `type` discriminator (`overseer.ts:398`, `:471`), and their edits ride
the existing chat OT stream, so read-before-edit, replay and compaction all work unchanged. A
worktree is **born pinned** at its base commit.

Three constraints shape what we can do with them today:

- **Chat-scoped.** A worktree belongs to the chat that created it and is deleted with the chat.
  Fresh agents create their own. Workspace-scoped worktrees are possible later but do not ship.
- **No UI.** Worktrees do not appear in the Workshop UI at all, and worktree *content* is stripped
  from every client delivery — otherwise the frontend's OT client would fetch an entire repository's
  base commit on both ends of the wire. Revision numbers are preserved, so the stream stays gapless;
  a stripped row may just carry an empty change. Worktree *ids* are not hidden, and
  client-submitted worktree changes are not rejected — "no UI" is a statement about the shipped
  frontend, not a server-enforced invariant.
- **Objects arrive lazily.** The workspace pulls what it needs on fault through the owning
  gatekeeper, typically shallow and filtered (§14.6), rather than cloning a repository up front.

### 14.5 The git flows exposed to the agent

Two surfaces, and the split matters.

**Tools** (`agent.ts`) — the normal path, and the one the agent is told to prefer:

| Tool | Git-relevant behaviour |
|---|---|
| `createWorktree(title, bindingName, commitId)` | Mounts a commit as a file tree under a binding name. `commitId` is a full 40-hex SHA-1 or an unambiguous prefix of ≥4 hex digits, and must already be *known to this workspace* — typically returned by a connection's API. This is also where the initial pull from the owning gatekeeper happens. |
| `readFile` / `writeFile` / `editFile` | Take a `workpiece` parameter, so they address a gadget or a worktree identically. On an unpinned gadget with committed code, `readFile` reads live at head and stamps the commit so replay can detect staleness; the first `editFile` pins the gadget at the current head. |
| `describeBinding` | Serves the worktree API below to the agent as text. |

**The `executeCode` worktree binding** (`workshop-backend/src/worktree-binding.d.ts`) — the
programmatic escape hatch, for anything beyond basic reads and edits:

```ts
listFiles(path?, {recursive?}): WorktreeFileEntry[]   // kind: file | executable | dir | symlink | submodule
readFile(path): string
writeFile(path, text): void        // edited executables keep their bit; new files are non-executable
deleteFile(path): void
grep(pattern: RegExp, path?): string                  // `grep -n` format, for humans/agents to read
structuredGrep(pattern, path?): StructuredGrepResult  // parse this one instead
commit(message): string            // commits the whole worktree, advances head, returns the new oid
diff(commitId?): string            // vs. head by default; any commit the workspace knows
```

The shape of that API is the interesting part:

- **There is no staging area.** `commit()` takes everything you have changed in the worktree. No
  index, no `git add`.
- **There is no branch, checkout, or ref anything** — consistent with §14.2. The worktree has a
  head, and `commit()` moves it. That is the entire ref surface.
- **`merge` and `reset` are explicitly TODO.** Upstream's note says a hard reset is better
  accomplished by creating a new worktree from the base commit, which is cheap.
- **Symlinks and submodules are visible but inert.** They appear in `listFiles` with their own
  `kind`, and file operations on them throw a descriptive error naming the symlink's target or the
  submodule's pinned commit. Searches skip them with a note.

So the agent's loop against a real repository is: ask a gatekeeper for a commit id → `createWorktree`
on it → read/edit with the ordinary file tools (or `executeCode` for bulk work) → `commit()` →
hand the resulting oid back to the gatekeeper to push or open a PR. Nothing in that loop lets the
agent reach a remote directly; the gatekeeper is the only door, and §14.6 is what it opens onto.

### 14.6 `GitCache` — the gatekeeper side

`GitCache` (`workshop-shared/src/gatekeeper.ts:1412`) is how a gatekeeper populates and reads the
workspace's object store. Any gatekeeper offering access to a remote repo is expected to implement
`Gatekeeper.gitPull()` alongside it (`:826`), because the workspace may evict objects and expects to
repopulate them from the same gatekeeper on demand.

```ts
get(id, hints?)        // null outside this gatekeeper's scoped view
has(id) / stat(id)
put(type, content)     // returns the computed oid — also the proof of possession
advertiseCommit(id)    // "my remote has this; pull it from me if the agent mounts it"
buildPack()            // action-scoped only: the applying action's pending-push closure
consumePack(stream)    // decode + hash-verify + store, equivalent to put() per object
isAncestor(a, b)       // over locally cached history only; throws if b isn't cached
```

Three design choices are worth carrying into anything we build:

- **The cache cannot be poisoned.** `put()` computes the oid from the bytes themselves; a gatekeeper
  that gets back an oid it did not expect should throw. Object ids are treated as capabilities
  throughout the system — which is also why `isAncestor` is deliberately *not* scoped to one
  gatekeeper's view, since the caller already holds both oids.
- **Every stub is scoped to the gatekeeper it was handed to**, and answers for exactly two sets:
  objects that gatekeeper `put()` or successfully pushed, and objects *queued* for push by a
  submitted-but-unapplied action (`ActionDescription.pushedCommits`, `:1215`). That second set is
  what makes simulation (§8.3) work for git: a commit pending push reads back as though it had
  already landed, so a gatekeeper simulating "read back the commit I just pushed" gets the right
  answer without the push having happened.
- **Pulls are shallow and filtered by default.** `GitPullHints` carries the object type, what
  referenced it, a `commitHistory` of `full` / `depth` / `since` — required, precisely because "the
  intuitive default would be a full clone, but that is almost never what we want" — and
  `filterBlobSize` / `filterTreeDepth`. Hints are advisory; honouring them affects performance,
  not correctness.

The GitHub gatekeeper implements this against the **real git smart-HTTP v2 protocol**, not the REST
API: `gatekeeper-github/src/git-transport.ts` composes pkt-line framing, fetch commands and sideband
demultiplexing for pulls, and a send-pack ref-update block for pushes, with the pack bytes coming
from `GitCache.buildPack()` and going into `consumePack()`. Two locked decisions: it never sends
`have`s (every pull is filtered or tree-limited, so possessing a commit never implies possessing its
blobs), and at most one `filter` line per fetch (upload-pack accepts a single filter-spec). Transfers
are capped at 64MB. The gatekeeper handles framing only and retains nothing locally.

Its agent-facing repository API is where branches and tags come back, since the store itself has
none: `listBranches`, `listTags`, `resolveRef(ref?)`, `getCommit(ref?)`, `listCommits(filter?)`,
`push(branch, commitId, {force?})`, plus PR operations. Every commit id it returns is advertised
through `advertiseCommit()` so the workspace knows where to pull it from — except ids that are only
*pending push*, which are withheld deliberately, since the hint would outlive a rejection.

**Push is an approval-gated action, not a call.** `push()` validates the branch name, refuses a
truncated commit id outright, reads the branch's current head as an authorized observation to bind
the expected old sha, and then submits an action carrying `pushedCommits: [commitId]` and
`implementsRevert: true`. Its description names the repository and the branch's current head, and a
force push says so explicitly: *"This is a force push: it rewrites the branch's history."* So an
agent pushing to a real repo lands in the same ApprovalQueue as any other side effect (§8.2), with
the fast-forward requirement validated at queue time via `isAncestor` before the action is even
submitted.

### 14.7 What this means for us

- **The §12 Context-collection plan is unaffected.** A git-backed Context collection still goes
  through Artifacts and `artifact-sync.ts` (§14.2). Nothing about the workspace git store changes
  how `skills/<name>/SKILL.md` folders get ingested.
- **A `gatekeeper-basecamp5` gets a new obligation if it ever returns commit ids** — implement
  `gitPull()`, or don't hand out oids. For a Basecamp gatekeeper this is moot; for anything wrapping
  a code host it is the main structural requirement.
- **"Agent edits our repo and opens a PR" is now a shipped path**, not a sketch — but it needs the
  GitHub gatekeeper connected and an OAuth app registered, and every push is an approval prompt. As
  a workflow that is a real option for the client-portal work in §11.1; as an *unattended* workflow
  it is not, by design.
- **Watch the ~2MB object ceiling and the absence of GC** before mounting anything large. Neither
  is enforced, and the media-service sketch in §11.2 should keep binaries in R2 rather than anywhere
  near a worktree.
