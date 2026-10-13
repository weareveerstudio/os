# @veer/gate-probe (`veeros-gk-probe`)

Foundation's proving gate: the smallest real studio gate, exercising everything the Clients,
Finance and Projects gates will be built on. Spec: [`docs/studio-os/specs/foundation.md`](../../docs/studio-os/specs/foundation.md).

- **Sidebar app "Probe"**: set a display name, add and archive notes, see your admin status, and
  (admins) read the audit log.
- **Agent session `ProbeSession`**: `listNotes()` and `getNote()` are observations; `addNote()` is an
  auto-approvable action delivered with simulation, so the note is visible to the workspace at once
  with `pending: true`.
- **Storage**: notes and the audit log in the fixed-name `ProbeNotesStore`; display name and admin
  mark in `StudioAccountState`; the action journal in each workspace's facet.

| File | Role |
| --- | --- |
| `src/probe.ts` | Vendor, account (`startAppUi`, `revoke`), verifier |
| `src/gatekeeper.ts` | Facet, session, the `addNote` action, simulation |
| `src/store.ts` | The shared notes store |
| `src/app-api.ts`, `src/ui-types.ts` | The flat `ui` capability and its types |
| `src/types.d.ts` (`types.txt` links to it) | The agent's only documentation; imports nothing |
| `app/` | The Kumo app, built into `src/generated/app.txt` |

## Checks

```sh
vp run -F @veer/gate-probe build             # app build, then tsc for worker, app and node configs
vp run -F @veer/gate-probe test              # workerd and jsdom suites
pnpm exec wrangler deploy --dry-run          # from this directory; never without --dry-run
```

Deploying goes through `scripts/deploy.ts` with `probe.enabled: true` in `deployment.jsonc`, and only
with the user's go-ahead. See `docs/studio-os/reports/foundation.md`.
