// Builds the Probe sidebar app into src/generated/app.txt. Run by the `build:app` task.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStudioApp } from "@veer/studio-kit/app-build";

await buildStudioApp({
  packageDirectory: dirname(fileURLToPath(import.meta.url)),
  gate: "probe",
  title: "Probe",
  unminified: process.argv.includes("--dev"),
});
