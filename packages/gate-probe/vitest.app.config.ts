import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** The sidebar app, in jsdom, against a fake `ui`. */
export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", include: ["__tests__/app/*.test.{ts,tsx}"] },
});
