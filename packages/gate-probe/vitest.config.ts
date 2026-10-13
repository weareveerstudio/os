import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { textModules } from "@veer/studio-kit/app-build";
import { defineConfig } from "vitest/config";

/** The Worker, in workerd, with the same flags it deploys with. */
export default defineConfig({
  plugins: [
    textModules(),
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          FACET_HOST: { className: "StudioFacetHost", useSQLite: true },
          NOTES_STORE: { className: "ProbeNotesStore", useSQLite: true },
          ACCOUNT_STATE: { className: "StudioAccountState", useSQLite: true },
          // Declared so `ctx.exports.ProbeGatekeeper` is a facet class, as it is in production.
          PROBE_GATEKEEPER: { className: "ProbeGatekeeper", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
