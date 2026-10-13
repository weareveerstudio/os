# Report: foundation

Built on `dev` against upstream `d420d9bb`. Nothing has been deployed, no secret set, and no
Cloudflare configuration changed. The probe ships disabled (`probe.enabled: false`).

Commits on `dev`, oldest first:

| Commit | What |
| --- | --- |
| `2a7ce11` | Bump `cloudflare-os` `b304e8c2` → `d420d9bb` (53 upstream commits), catalog re-synced |
| `a09ac3c` | `packages/studio-kit` and the Foundation spec |
| `bf0297b` | `packages/gate-probe` (`veeros-gk-probe`) |
| `6fbe64b` | Deploy wrapper: `studioGates`, `probe` block, golden and probe tests |
| (this commit) | Review fixes, this report, canon re-verified at `d420d9bb` |

## 1. What was built

- **Upstream bump.** `d420d9bb` is upstream `main` as of 2026-10-13. Of the deployed base configs only
  GitHub's changed: migration `v1` adds the `GitHubHookDriver` class (additive). Gatekeeper contract
  changes are optional additions (`createResource`, `applyCreation`, `creatable`). Workshop storage
  changes are additive fields.
- **Workspace.** `gatekeeper-kit` and `observability` are workspace members; the catalog gains `diff`,
  mirrored byte for byte. `typed-storage` was not added (hand-written SQLite, see the spec).
- **`packages/studio-kit`** (`@veer/studio-kit`): see its [README](../../../packages/studio-kit/README.md).
  The app shell, single-file build with the frame's own CSP, Kumo token overrides generated from the
  Workshop, `StudioAccountState` (display name, admin mark), the trigger-enforced append-only audit
  log, `migrate()`, store naming, `agentWrite` and the applied-action ledger, observation helpers,
  guards, and workerd test helpers.
- **`packages/gate-probe`** (`@veer/gate-probe`, Worker `veeros-gk-probe`, sidebar app "Probe"): see
  its [README](../../../packages/gate-probe/README.md). Shared notes; the app lists, adds and archives
  notes, shows admin status, and shows admins the audit log. The agent session lists and reads notes
  as observations and adds a note as an auto-approvable, continue-with-simulation action.
- **Deploy wrapper.** `scripts/deploy.ts` gains a `studioGates` table; `deployment.jsonc` gains
  `workers.probe` and `probe.enabled: false`.
- **Docs.** The spec ([`specs/foundation.md`](../specs/foundation.md)) and the canon re-verified at
  `d420d9bb`, with five corrections: the app's CSP is its own, one handshake per mount, `openPrompt`
  prefills the Home launcher, icons are masks, and `/admin` "disabled" deletes facet storage.

## 2. Checks

All run from the repository root on Node 24.21 and pnpm 11.17.

| Command | Result |
| --- | --- |
| `pnpm lint` | Pass: `vp lint` (warnings only, in tests), `tsc` for `scripts/`, every package build |
| `pnpm test` | Pass: 47 script tests; studio-kit 25 workerd + 7 node + 6 jsdom; gate-probe 20 workerd + 6 jsdom; upstream gatekeeper-kit 701 + 124, observability 34, error-reporting 23, custom-gatekeeper 2, error-reporter 2 |
| `pnpm check` (probe off) | Pass: six dry-runs, no `GATEKEEPER_PROBE` anywhere |
| `pnpm check` (probe on, temporarily) | Pass: seven dry-runs; `veeros-gk-probe` bundles at 779 KiB (211 KiB gzip); the Workshop shows `env.GATEKEEPER_PROBE (veeros-gk-probe#GatekeeperVendor)` and the router `env.GATEKEEPER_PROBE (veeros-gk-probe)` |

Acceptance from the brief:

- **Byte-identical when off.** Proven two ways. The golden test regenerates `main`'s output for three
  synthetic deployments (`scripts/testdata/`). And by hand, against the real `deployment.jsonc` and
  base configs: all six generated configs are identical to those `main`'s generator produced at the
  same pin.
- **Probe on.** The router and the Workshop each gain exactly one `GATEKEEPER_PROBE`, appended last;
  every other Worker's config is unchanged (tested).
- **Unit tests in the workerd pool** cover every `ui` method, the submit/apply/reject path,
  simulation (a pending note is visible to the agent before approval), audit rows, and the admin
  mark.

Noted, not a problem: the Workshop and router bundles differ by 0.01 KiB between dry-runs on the same
upstream code; they are built in the submodule's own workspace, which this change does not touch.

## 3. Review

REVIEW_PLACEHOLDER

## 4. Deploy plan

Two deploys, so that a problem is attributable: first the upstream bump on its own, then the probe.
Each needs your go-ahead. Run everything from the repository root.

### Before either deploy

```sh
git submodule update --init
pnpm install
pnpm --dir cloudflare-os install
pnpm exec wrangler login
pnpm exec wrangler whoami            # must show account cae2b6350c3a5a8bc9451652ffb0c9d7
```

Record the live version of every Worker the deploy touches, so you can roll back:

```sh
for w in veeros veeros-backend veeros-gk-context veeros-gk-scheduler veeros-gk-mcp veeros-gk-github; do
  CLOUDFLARE_ACCOUNT_ID=cae2b6350c3a5a8bc9451652ffb0c9d7 pnpm exec wrangler deployments list --name "$w" | head -20
done
```

| Worker | Live version before | Version after A | Version after B |
| --- | --- | --- | --- |
| `veeros-gk-context` | | | |
| `veeros-gk-scheduler` | | | |
| `veeros-gk-mcp` | | | |
| `veeros-gk-github` | | | |
| `veeros-gk-probe` | (new) | (not deployed) | |
| `veeros-backend` | | | |
| `veeros` (router) | | | |

### Deploy A: the upstream bump, probe still off

1. `pnpm check`: six dry-runs, all green.
2. `pnpm deploy`. Order: Context, Scheduler, MCP, GitHub, Workshop, router.
3. GitHub's Worker applies migration `v1` (adds `GitHubHookDriver`; nothing removed).
4. Run the "after A" checks below.

### Deploy B: the probe

1. Set `"probe": { "enabled": true }` in `deployment.jsonc` and commit it.
2. `pnpm check`: seven dry-runs, including `veeros-gk-probe`.
3. `pnpm deploy`. Order: Context, Scheduler, MCP, GitHub, **Probe**, Workshop, router. The first
   deploy creates `veeros-gk-probe` with migration `v1` (`StudioAccountState`, `ProbeNotesStore`,
   `ProbeGatekeeper`). No secrets are needed.
4. In `/admin`, find Probe among the Gatekeepers. Its mode starts as `optional`, so each person opts
   in on the Connectors page. Choose `enabled` instead only if everyone, contractors included, should
   get it automatically.
5. Run the "after B" checks below.

### Rollback

- **The probe misbehaves.** Set its mode to `disabled` in `/admin`. No deploy is needed. The app
  disappears, and each workspace drops its Probe capsule on its next open. That deletes the capsule's
  journal, including pending agent notes. Accounts and the studio's notes stay in the probe's Durable
  Objects.
- **Probe code.** `pnpm exec wrangler rollback --name veeros-gk-probe <version-id>`, to a version that
  has the same migrations.
- **Unbind the probe.** Set `probe.enabled: false` and `pnpm deploy`. The Workshop and router
  redeploy without `GATEKEEPER_PROBE`. The probe Worker keeps running with its data, and its accounts
  become invisible rather than gone. Do not delete the Worker: its Durable Objects hold the data.
- **The bump.** Redeploy the previous root commit (`23a8082`, submodule `b304e8c2`) with
  `pnpm deploy`. One exception: GitHub's migration `v1` cannot be undone by redeploying older code.
  Wrangler may refuse a config without the applied tag, so prefer a forward fix for `veeros-gk-github`.
  Version rollback (`wrangler rollback`) restores code, not Access, bindings, secrets or data.

## 5. Manual verification (signed in at https://os.veer.studio)

### After A (the bump)

- [ ] Sign in through Access. The home page loads, and a chat runs a model turn.
- [ ] The Scheduled app lists existing schedules. The Context library opens.
- [ ] A connected GitHub account still lists repositories in a chat.
- [ ] `/admin` loads for an admin and refuses a non-admin.

### After B (the probe)

App, as an admin:
- [ ] "Probe" appears in the sidebar, with a monochrome flask icon in light and dark mode (opt in on
      Connectors first if the mode is `optional`).
- [ ] The app shows an "Admin" badge and asks for a display name. Adding a note is disabled until the
      name is set.
- [ ] Set a name, add a note (line breaks kept), and see it signed with that name.
- [ ] Archive it. It disappears; "Show archived" brings it back with "Archived by <name>".
- [ ] The audit log lists "set their display name", "added a note" and "archived a note", newest first.
- [ ] Switch the Workshop between light and dark, and change the accent colour in `/admin`. The app
      follows without a reload.

App, as a non-admin (a contractor account):
- [ ] The app shows "Member" and no audit log. Adding and archiving work once a name is set.

Agent path. Start a **new** chat: a newly deployed gate's capsule appears only in chats started after
it.
- [ ] Ask the agent to list Probe notes. The read appears in the workspace's Activity as "List Probe
      notes".
- [ ] Ask it to add a note. The first time in a workspace it waits for approval as "Add a Probe
      note", with the note shown in a field. Approve with "Always approve this type".
- [ ] Before approving, the agent's own `listNotes()` already shows the note with `pending: true`.
- [ ] After approval the note appears in the app as "Agent" plus the workspace title. Clicking the
      title opens the workspace.
- [ ] A second note in the same workspace applies without asking.
- [ ] Add one more note and reject it. It disappears from the agent's view and never reaches the app.
- [ ] Share the workspace with the other partner. They can open it; Probe admits every collaborator.

Then decide the probe's lifetime (section 6).

## 6. Follow-ups and decisions for you

1. **Probe lifetime.** Recommendation: after verification, keep the Worker deployed as a lab gate and
   set its mode to `disabled` (or leave it `optional`, unused). Its accounts persist once provisioned.
2. **Agent applies are in the audit log too.** The brief asked for human edits; the probe also logs
   approved agent writes, so the log is the store's whole history. Say if you want human edits only.
3. **The spec was not reviewed before the build.** It was written and built in one session at your
   request. Review it together with the code.
4. **The `studio-spec` and `studio-build` workflows** hardcode `ROOT=/Users/shahriar/...` and forbid
   commits. They work on your Mac, not in a cloud session; this session followed the same steps by
   hand and committed to `dev` because a cloud container is discarded.
5. **`pnpm test` now runs upstream gatekeeper-kit's suite** (825 tests) because the kit is a workspace
   member. It proves the kit works under this install; filter it out in the root `test` script if
   the time matters.
6. **Test noise.** The workerd pool logs `uncaught exception` lines for Durable Object calls that
   reject on purpose. The runs pass with no unhandled errors; upstream's suites show the same.
7. **Frontend error reporting** is not wired into studio apps. It is disabled for this deployment
   anyway (`errorReporting.enabled: false`).
8. **Next targets:** Clients, then Finance and Projects, each starting from a brief.
