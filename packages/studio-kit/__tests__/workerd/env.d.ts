// Types for the workerd suite's environment: `env` from the vitest miniflare config, and
// `ctx.exports` from the test worker's module.

import type { StudioAccountState } from "../../src/account-state.js";
import type { KitTestStore } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.js");
      durableNamespaces: "StudioAccountState" | "KitTestStore" | "StudioFacetHost";
    }
    interface Env {
      ACCOUNT_STATE: DurableObjectNamespace<StudioAccountState>;
      KIT_STORE: DurableObjectNamespace<KitTestStore>;
    }
  }
}
