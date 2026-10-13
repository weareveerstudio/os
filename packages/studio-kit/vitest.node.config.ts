import { defineConfig } from "vitest/config";

/** The build helpers, in Node: token sync and the app build configuration. */
export default defineConfig({
  test: { environment: "node", include: ["__tests__/node/*.test.ts"] },
});
