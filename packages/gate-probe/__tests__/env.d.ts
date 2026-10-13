// The workerd suite's `env`, from the vitest miniflare config.
import type { StudioAccountState } from "@veer/studio-kit/account-state";
import type { StudioFacetHost } from "@veer/studio-kit/testing";
import type { ProbeNotesStore } from "../src/store.js";

declare global {
  namespace Cloudflare {
    interface Env {
      FACET_HOST: DurableObjectNamespace<StudioFacetHost>;
      NOTES_STORE: DurableObjectNamespace<ProbeNotesStore>;
      ACCOUNT_STATE: DurableObjectNamespace<StudioAccountState>;
    }
  }
}
