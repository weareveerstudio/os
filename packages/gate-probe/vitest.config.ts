import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { parse } from "jsonc-parser";
import capnwebValidate from "capnweb-validate/vite";
import { textModules } from "@veer/studio-kit/app-build";
import { defineConfig } from "vitest/config";

// Read from the config the Worker deploys with, so the two cannot drift.
const deployed = parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8")) as {
  compatibility_date: string;
  compatibility_flags: string[];
};

/** The Worker, in workerd, with the same date and flags it deploys with. */
export default defineConfig({
  plugins: [
    textModules(),
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: deployed.compatibility_date,
        compatibilityFlags: deployed.compatibility_flags,
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
