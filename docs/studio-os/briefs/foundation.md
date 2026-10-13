# Brief: Foundation

**Goal:** before the first real gate, prove every platform assumption the three gates share, once,
and leave behind the shared pieces they will be built on. The canon is
[`../architecture.md`](../architecture.md); this brief adds only what is specific to Foundation.

## Deliverables

1. **Wrapper support for studio gates.**
   - `scripts/deploy.ts` and `scripts/deployment-config.ts` gain a `studioGates` table: gates whose
     package lives in this repo (`packages/gate-<key>`).
   - Each entry has: a `deployment.jsonc` block with `enabled` and settings; `workers.<key>.name`;
     binding `GATEKEEPER_<KEY>`; a derived `BASE_URL`; a build command for a wrapper package; and the
     compatibility flags it needs.
   - Each entry is bound bare on the router and as `GatekeeperVendor` on the Workshop, and deployed
     after the vendor gatekeepers and before the Workshop.
   - With every studio gate off, the generated configs of existing Workers stay byte-identical, and
     tests prove it.
2. **Workspace additions:** `gatekeeper-kit`, `observability` (and `typed-storage` if the spec picks
   it) become workspace members, with catalog entries mirrored from the submodule.
3. **`packages/studio-kit`, the shared library:**
   - **App shell:** a single-file build (React + Kumo + Tailwind) modelled on gatekeeper-scheduler,
     with theme and accent sync and a typed helper for calling the flat `ui` capability.
   - **Server helpers:**
     - The auto-provisioned vendor/account/singleton skeleton.
     - Names for shared-store Durable Objects.
     - An account profile holding a self-declared display name.
     - The admin mark, used by Finance.
     - An append-only audit log for human edits made in the app.
     - Conventions for wiring `defineActions`, `buildDescription`, simulation and observers.
   - **Test helpers** for the workerd test pool.
4. **`packages/gate-probe`** (`veeros-gk-probe`, sidebar app "Probe"): the smallest real gate that
   exercises everything above.
   - A shared "notes" store.
   - The `ui` lets you list, add and archive notes, and shows `isAdmin`.
   - The agent session can list and read notes (observations) and add a note as an action that is
     `autoApprovable` with `continue-with-simulation`.
   - Open observers, and the facet reports its workspace id.
   - Human edits made in the app are written to the audit log.
5. **A verification plan:** the automated checks, plus a manual checklist for a signed-in browser
   session after deploy.

## Research questions

1. **Deploy wrapper.** How do `deploy.ts` and `deployment-config.ts` drive `vendorGatekeepers`,
   `customGatekeeper` and the error reporter today: validation, placeholders, generated configs,
   binding lists, build steps and deploy order? What are the smallest changes for wrapper-owned studio
   gates, and which `scripts/deploy.test.ts` fixtures and assertions should they extend?
2. **The scheduler template.** In `cloudflare-os/packages/gatekeeper-scheduler`, how are the
   vendor/account/facet split, `singleton` + `providesUi`, `startAppUi`/`ui`, the app build
   (`vite.config.ts`, `build-app.ts`, `vite.app.config.ts`, `app/*`), theme sync, the cloudflare
   config/wrangler setup, Durable Object migrations and tests put together? Which files should be
   copied and which generalised into studio-kit?
3. **The gatekeeper-kit recipe.** How does the conformance fixture assemble `defineActions`,
   `ActionJournal`, simulation, `buildDescription` and the observer strategies into a working
   gatekeeper? What config does a kit-based gatekeeper need: compatibility flags, the capnweb-validate
   entrypoint, `@validateRpc`?
4. **Workspace and packaging.** What does adding `gatekeeper-kit`, `observability` and optionally
   `typed-storage` to this repo's pnpm workspace require (dependencies, catalog entries, build order,
   `dist` outputs)? How do `packages/custom-gatekeeper` and `packages/error-reporter` build and test
   today?
5. **Kumo in the app.** Which Kumo version and token overrides does the Workshop use, and how do
   Context and Scheduler differ (Kumo React components versus tokens only)? What bundle size can we
   expect? How should the shell copy the Workshop's token overrides so they stay in sync on bumps?

## Acceptance

- `pnpm lint`, `pnpm test` and `pnpm check` pass.
- With `probe.enabled: false`, every existing Worker's generated config is byte-identical to `main`.
- With `probe.enabled: true`, the `pnpm check` dry-run lists `veeros-gk-probe`, and the router and
  backend each gain exactly one `GATEKEEPER_PROBE` binding.
- studio-kit and gate-probe have unit tests in the workerd pool. They cover the `ui` methods, the
  action submit/apply/reject path, simulation (a pending note is visible to the agent before it is
  approved), the audit log rows and the admin mark.
- A deploy plan lists the order, commands, the live version IDs to read first, and rollback.

## Out of scope

Deploying, setting secrets, changing Access or other Cloudflare configuration, and committing are all
left to the user. Also out of scope: real Clients, Finance or Projects features, and upstream
submodule changes.

## Open for the spec to decide

- Whether the probe stays deployed as a permanent "lab" gate or is disabled after verification. Its
  accounts persist once provisioned.
- `typed-storage` versus hand-written SQLite.
- Whether studio-kit's app shell uses Kumo React components (Context) or tokens only (Scheduler).
