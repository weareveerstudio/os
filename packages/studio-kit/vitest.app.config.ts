import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** The app shell, in jsdom. */
export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", include: ["__tests__/app/*.test.{ts,tsx}"] },
});
