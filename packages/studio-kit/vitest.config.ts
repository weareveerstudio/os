import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** The Worker-side library, in workerd: Durable Object storage, SQLite triggers, RPC targets. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          ACCOUNT_STATE: { className: "StudioAccountState", useSQLite: true },
          KIT_STORE: { className: "KitTestStore", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
