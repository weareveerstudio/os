// veeros-gk-probe: Foundation's proving gate. Every class the Workshop or the runtime reaches is
// exported here; wrangler's migrations name the three Durable Object classes.
export { StudioAccountState } from "@veer/studio-kit/account-state";
export { ProbeGatekeeper } from "./gatekeeper.js";
export { ProbeNotesStore } from "./store.js";
export { GatekeeperVendor, ProbeAccount, ProbeVerifier } from "./probe.js";

/** The router forwards /gatekeeper/probe here. The probe serves no pages; this answers health checks. */
export default {
  async fetch(): Promise<Response> {
    return new Response("VEER Studio Probe gate.", { headers: { "content-type": "text/plain" } });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
