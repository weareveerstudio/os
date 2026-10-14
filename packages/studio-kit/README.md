# @veer/studio-kit

Shared pieces for the VEER Studio OS gates (Clients, Finance, Projects, and the Foundation probe).
Not a deployable Worker. The canon is [`docs/studio-os/architecture.md`](../../docs/studio-os/architecture.md).

Consumed as TypeScript source through the `exports` map, like gatekeeper-kit. Classes that answer RPC
from outside a gate's Worker (vendor, account, facet, session, app `ui`) carry `@validateRpc()` and
therefore live in the gate's own `src`, because `capnweb-validate build` transforms only that tree.
Everything here is either a plain helper or a Durable Object reached through the gate's own
`ctx.exports`.

## Modules

| Import | What it gives a gate |
| --- | --- |
| `./describe` | `studioVendorDescription`, `studioAccountDescription` (singleton + sidebar app), `svgIcon` |
| `./account-state` | `StudioAccountState` (display name, admin mark, `revoke()`), `requireAdminMark` |
| `./stores` | `SHARED_STORE_NAME`, `sharedStore(ns)`, `storeName(partition)` |
| `./sql` | `migrate(storage, steps)`: append-only, transactional schema steps |
| `./audit-log` | `AuditLog`, `AUDIT_LOG_MIGRATIONS`: append-only (trigger-enforced) change history |
| `./actions` | `agentWrite` (auto-approvable, continue-with-simulation), `actionKind`, `operationId`, `AppliedActions` |
| `./simulation` | `foldPending`: show an agent its own pending writes in every read |
| `./observers` | `observation()` descriptions, `BASELINE`, the kit's gate and strategies |
| `./guards` | `requireAdmin`, `requireText`, `requireId` |
| `./testing` | `FakeApprovalQueue`, `StudioFacetHost`, `rejectionMessage` for workerd suites |
| `./app/ui-client` | `FlatUi`, `UiClient`, `errorMessage` (no DOM, so a Worker can import it) |
| `./app` | `mountStudioApp`, `usePolled`, `useMutation`, `FlatUi`, `UiClient`, `errorMessage` |
| `./app/styles.css` | Kumo styles, Tailwind, and the Workshop's token overrides |
| `./app-build` | `buildStudioApp`: one inlined HTML file with the frame's CSP, emitted as `src/generated/app.txt` |

## Rules the helpers encode

- **Every agent write is `agentWrite(...)`.** The Workshop's approval queue stops at the first action
  that needs a human, so one approval-only kind stalls every later write from the gate.
- **`applyAction` is idempotent** on an `operationId()` minted at submit and kept in the payload,
  claimed with `AppliedActions` in the same transaction as the write. Never on the journal's action
  id: it restarts at 1 when a workspace's capsule is re-created.
- **The `ui` is flat.** The host's rate limiter forwards top-level method names only. Implement the
  app's interface as `class XAppApi extends RpcTarget implements FlatUi<XUi>`.
- **The app never reloads itself.** The host accepts one handshake per mount.
- **The app declares its own CSP.** The Workshop injects none; `buildStudioApp` writes it.
- **Human edits are audited** in the same transaction as the edit, and require a display name. The
  one exception is a display-name change: the name lives in `StudioAccountState`, so it is audited
  first and saved second, and a failure in between leaves a record of a change that a retry repeats.

## Keeping in step with the Workshop

`app/tokens.css` is generated from the Workshop's `styles.css`. After a submodule bump, run
`node packages/studio-kit/build/tokens.ts --write`; `pnpm test` fails until it is current.

## Checks

```sh
vp run -F @veer/studio-kit build   # tsc: worker, app, node configs
vp run -F @veer/studio-kit test    # workerd, node, and jsdom suites
```
