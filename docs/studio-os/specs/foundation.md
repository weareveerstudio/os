# Spec: foundation

Status: Draft for user review. Written by hand in a cloud session against upstream `d420d9bb`, not by
the `studio-spec` workflow. The build went ahead in the same session at the user's request ("start
building"), so review this spec together with the code it describes.

## 1. Summary

Foundation proves the platform assumptions the three studio gates share and leaves behind the shared
pieces they build on:

- **Deploy wrapper support** for gates whose package lives in this repo: a `studioGates` table in
  `scripts/deploy.ts`, a `probe` block in `deployment.jsonc`, and tests that hold every existing
  Worker's generated config byte-identical while every studio gate is off.
- **`packages/studio-kit`** (`@veer/studio-kit`): the single-file Kumo app shell and its build, the
  account-state Durable Object (display name and admin mark), the append-only audit log, the
  shared-store naming and SQLite migration helpers, the action and observer wiring conventions, and
  test helpers for the workerd pool.
- **`packages/gate-probe`** (`@veer/gate-probe`, Worker `veeros-gk-probe`, sidebar app "Probe"): the
  smallest real gate that exercises all of the above against a shared "notes" store.

Nothing is deployed. The probe ships disabled (`probe.enabled: false`).

## 2. Inherited decisions

From [`../architecture.md`](../architecture.md):

- Decision 1: every gate is a Gatekeeper with a sidebar app (`providesUi`) and an ambient singleton.
- Decision 2: one Worker per gate. The probe reads and writes only its own storage.
- Decision 3: accounts are auto-provisioned, `AppUiContext.isAdmin` is the only authority signal,
  authors are self-declared display names, and agent writes carry the workspace they came from.
- Decision 4: the permission model is admin or not.
- Decision 5: the UI is Kumo, built as one inlined HTML file.
- Decision 6: human edits in the app apply immediately and are written to the gate's audit log.
  Agent writes are `autoApprovable` with `delivery: "continue-with-simulation"`, and no kind is
  approval-only.
- Decision 7 (Finance) shapes only the admin mark here; the probe is not restricted.
- Platform constraints: flat `ui` API, no popups or downloads in the iframe, account description
  frozen at creation, shared data in fixed-name Durable Objects, journal in facet storage,
  `applyAction` idempotent on `${workspaceId}:${actionId}`.

## 3. Design

### Components (one Worker per gate)

| Export | Kind | Role |
| --- | --- | --- |
| `GatekeeperVendor` (default) | `WorkerEntrypoint` | `describe()` with `autoProvisionsAccount: true`; `createAccount()` mints `ProbeAccount({props:{accountId: randomUUID()}})` |
| `ProbeAccount` | `WorkerEntrypoint<{accountId}>` | `describe()` (singleton + providesUi), `getSingletonGatekeeperClass()`, `startAppUi()`, `revoke()`, `getVerifier()` |
| `ProbeVerifier` | `WorkerEntrypoint` | Trivial verifier, as the open observer policy needs none |
| `ProbeGatekeeper` | `DurableObject<{accountId}>` facet | Per-workspace facet: session, journal, apply/reject |
| `ProbeNotesStore` | `DurableObject` | The studio-wide notes store, fixed name |
| `StudioAccountState` | `DurableObject` (from studio-kit) | Per-account display name and admin mark, `getByName(accountId)` |

Every class that answers RPC from outside the Worker carries `@validateRpc()` and lives in the gate
package, because `capnweb-validate build` transforms only the package's own `src` tree. studio-kit
exports plain helpers and Durable Object classes reached only through the gate's own `ctx.exports`,
like the Scheduler's `ScheduleDriver`.

### Identity

- The app knows the account (props) and `isAdmin` (fresh per mount). The author of a human edit is
  the account's self-declared display name, stored in `StudioAccountState`. A human write is refused
  until a display name is set, so no row is ever authored by nobody.
- The agent acts through the workspace owner's account. An agent write records
  `{kind: "agent", workspaceId, accountId}`. The app shows it as "Agent" plus the workspace title,
  resolved live through the host's `resolveWorkspaceTitles`.
- The admin mark: `startAppUi` calls `markAdmin(isAdmin)` on the account state on every mount. The
  probe only records and displays it; Finance will check it on every session call.

### Domain model (probe)

A note: `id` (UUID minted at submit time for agent writes, at insert for human writes), `body`
(1 to 2000 characters after trimming), `createdAt`, `author`, `archivedAt`, `archivedBy`. Notes are
never deleted; archive is the only removal. Archiving is a human-only operation in the app, which
matches decision 6's pattern for completing work.

## 4. Agent surface

`src/types.d.ts` (self-contained; imports nothing):

```ts
export type ProbeAuthor =
  | { kind: "person"; name: string }
  | { kind: "agent"; workspaceId: string };

export interface ProbeNote {
  id: string;
  body: string;
  createdAt: string;        // ISO 8601
  author: ProbeAuthor;
  archived: boolean;
  pending: boolean;         // queued by this workspace, not yet approved
}

export interface ProbeSession {
  listNotes(options?: { includeArchived?: boolean }): Promise<ProbeNote[]>;
  getNote(id: string): Promise<ProbeNote | null>;
  addNote(body: string): Promise<ProbeNote>;
}
```

- `listNotes` and `getNote` are observations, authorized through `ObservationGate` with the
  `openObservers()` strategy and scope `{kind: "baseline"}`, after the read and before returning. A
  `getNote` that finds nothing is still authorized, so the session is not an existence oracle.
- Observation and action descriptions carry agent-supplied text only in typed fields (built with
  `buildDescription`), never in prose.

| Action kind | Tag | autoApprovable | delivery | Description fields |
| --- | --- | --- | --- | --- |
| `addNote` | `probe.add-note` (label "Add a Probe note") | true | `continue-with-simulation` | `inline("Note ID")`, `verbatim("Note")` |

- Simulation: reads fold the facet's pending `addNote` actions over the store with
  `createSimulationView` / `replaySimulation`. A pending note is returned with `pending: true`
  before approval. A pending note whose id already exists in the store is a known no-effect step.
- Fence: `"none"`. The probe has no provider connection, so nothing can change authority under an
  action.
- `applyAction` writes to the store keyed `${workspaceId}:${actionId}`. A replay is a no-op.
- `rejectAction` drops the journal record; nothing was written, so nothing to undo.
- `revertAction` returns a message pointing at archive in the app (`implementsRevert: false`).
- Agent catalog: `null` (no discovery index). Slash commands: none.

## 5. App surface

Flat `ui` (`ProbeAppApi`, every method top-level):

| Method | Who | Effect |
| --- | --- | --- |
| `getViewer()` | all | `{isAdmin, displayName}` |
| `setDisplayName(name)` | all | Sets the self-declared name; audited |
| `listNotes({includeArchived?})` | all | Notes, newest first |
| `addNote(body)` | all, with a display name | Inserts immediately; audited |
| `archiveNote(id)` | all, with a display name | Archives immediately; audited; idempotent |
| `listAuditLog({limit?, before?})` | admins | Newest-first page of audit rows |

Screens: one page with the viewer card (display name form, admin badge), an add-note form, the note
list (author, time, archive button, "show archived" toggle), and, for admins, the audit log. The app
polls `listNotes` every 15 seconds while visible, because the host has no live push.

Audit log rows: `{seq, at, actor, action, target, detail}`, where `actor` is
`{kind: "person", accountId, name, isAdmin}` or `{kind: "agent", accountId, workspaceId}` and
`action` is one of `profile.set-name`, `note.add`, `note.archive`. Agent applies are logged too, so
the log is the store's complete change history. Rows are append-only, enforced by SQLite triggers.

## 6. Storage

| Durable Object | Name | Holds |
| --- | --- | --- |
| `ProbeNotesStore` | fixed `"veer-studio"` (studio-kit `SHARED_STORE_NAME`) | `notes`, `studio_audit_log`, `studio_applied_actions` |
| `StudioAccountState` | `accountId` | KV keys `profile`, `admin-mark` |
| `ProbeGatekeeper` (facet) | per workspace | kit `ActionJournal` under namespace `probe` |

Schema changes go through studio-kit's `migrate(sql, steps)`, which applies numbered steps once, in
order, recorded in `studio_schema_migrations`. Wrangler migration `v1` adds the three SQLite classes.
`revoke()` deletes the account's `StudioAccountState` storage only; studio data stays.

`typed-storage` is not used: it has no migrations and builds to `dist`, while hand-written SQLite
gives later gates (ledgers, todo lists) explicit schemas and steps.

## 7. Integration

None. The probe exposes no API to other gates and serves no HTTP beyond a plain-text health response
at `/gatekeeper/probe`.

## 8. Deployment

- `deployment.jsonc`: `"workers": {"probe": {"name": "veeros-gk-probe"}}` and
  `"probe": {"enabled": false}`.
- `studioGates` table entry: `{key: "probe", binding: "GATEKEEPER_PROBE", pkg: "@veer/gate-probe",
  dir: "packages/gate-probe"}`. Bound bare on the router and as `GatekeeperVendor` (no props) on the
  Workshop, appended after every existing binding. `BASE_URL` is `<origin>/gatekeeper/probe`.
- Build: `pnpm exec vp run -F @veer/gate-probe --no-cache build`, whose `dependsOn: ["build:app"]`
  rebuilds the app from source.
- Deploy order: Error Reporter, Context, Scheduler, vendor Gatekeepers, custom Gatekeeper, **studio
  gates**, Workshop, router.
- Compatibility: date `2026-09-04`, flags `allow_irrevocable_stub_storage` (later gates persist
  verifier stubs) and `nodejs_als` (gatekeeper-kit's logger). `workers_dev` and preview URLs off, as
  for every Worker.
- Rollback: set the probe's mode to disabled in `/admin` (no deploy); `wrangler rollback` for
  code-only changes; `probe.enabled: false` plus a deploy to unbind it. The report has the full plan.

## 9. Verification

Automated (`pnpm lint`, `pnpm test`, `pnpm check`):

- `scripts/deploy.test.ts`: probe off leaves the generated configs byte-identical to a golden file
  produced by `main`'s generator; probe on adds exactly one `GATEKEEPER_PROBE` binding to the router
  and the Workshop and a probe config with `BASE_URL`, flags, migrations, no route; build steps;
  validation.
- `scripts/studio-types.test.ts`: every `packages/gate-*/src/types.d.ts` imports nothing.
- studio-kit (workerd): account state, admin mark, audit log append-only, migrations, store names.
- studio-kit (node): token overrides match the Workshop's `styles.css`.
- gate-probe (workerd): vendor and account descriptions, `startAppUi` (HTML, admin mark), every `ui`
  method including the admin gate and the display-name requirement, audit rows, the session's
  observations, submit, simulation (a pending note visible before approval), apply (idempotent),
  reject, and the facet's workspace id.
- gate-probe (jsdom): the page renders, adds and archives through a fake `ui`.

Manual (after deploy): see the report, `docs/studio-os/reports/foundation.md`.

## 10. Risks and open questions for the user

1. **Probe lifetime.** Recommendation: deploy it, verify, then set its mode to disabled in `/admin`
   and keep the Worker deployed as a lab gate. Its accounts persist once provisioned, and dropping
   the binding leaves them invisible rather than gone. Disabling deletes each workspace's capsule
   storage (the journal, so pending agent notes) on its next open; the store and accounts stay.
   The mode starts as `optional`, so each person opts in on the Connectors page; `enabled`
   provisions it for everyone, contractors included.
2. **Agent writes in the audit log.** The brief asks for human edits; this spec also logs agent
   applies so the log is a full change history. Say if you want human edits only.
3. **Archive is human-only.** Agents can add notes but not archive them, mirroring "completing work
   is human-only". Fine for a probe; later gates decide per operation.
4. **Display name required before any human write.** Prevents anonymous rows. The first visit asks
   for it.
5. **Spec review.** This spec was not reviewed before the build. Anything you change here should be
   treated as a change request against the code on `dev`.

## 11. Work breakdown

```json
{"packages":[
  {"id":"workspace","title":"Workspace members and dependencies","paths":["package.json","pnpm-workspace.yaml","pnpm-lock.yaml","packages/studio-kit/package.json","packages/gate-probe/package.json",".gitignore"],"dependsOn":[],"instructions":"Add cloudflare-os/packages/gatekeeper-kit and cloudflare-os/packages/observability as workspace members; mirror the `diff` catalog entry byte-identically; create the two package.json files with every dependency; pnpm install.","acceptance":["pnpm install --frozen-lockfile succeeds","pnpm ls -r --depth -1 lists @gadgets/gatekeeper-kit, @veer/studio-kit, @veer/gate-probe"]},
  {"id":"studio-kit","title":"Shared library","paths":["packages/studio-kit/src/**","packages/studio-kit/app/**","packages/studio-kit/__tests__/**","packages/studio-kit/*.ts","packages/studio-kit/*.json","packages/studio-kit/README.md"],"dependsOn":["workspace"],"instructions":"Implement sections 3, 5 and 6's shared pieces.","acceptance":["vp run -F @veer/studio-kit test passes","vp run -F @veer/studio-kit build passes"]},
  {"id":"gate-probe","title":"Probe gate","paths":["packages/gate-probe/src/**","packages/gate-probe/app/**","packages/gate-probe/__tests__/**","packages/gate-probe/*.ts","packages/gate-probe/*.jsonc","packages/gate-probe/tsconfig*.json","packages/gate-probe/README.md"],"dependsOn":["studio-kit"],"instructions":"Implement sections 3 to 6 for the probe.","acceptance":["vp run -F @veer/gate-probe test passes","pnpm exec wrangler deploy --dry-run in packages/gate-probe succeeds"]},
  {"id":"deploy","title":"Deploy wrapper","paths":["scripts/**","deployment.jsonc"],"dependsOn":["workspace"],"instructions":"Implement section 8 and its tests.","acceptance":["node --test scripts/deploy.test.ts passes","pnpm types:scripts passes"]},
  {"id":"docs","title":"Report and canon pin","paths":["docs/studio-os/reports/foundation.md","docs/studio-os/architecture.md"],"dependsOn":["gate-probe","deploy"],"instructions":"Write the report (deploy plan, rollback, manual checklist) and update the canon's verified pin.","acceptance":["the report lists the deploy order, commands, version IDs to read, and rollback"]}
]}
```
