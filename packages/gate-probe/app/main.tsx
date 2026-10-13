import { mountStudioApp } from "@veer/studio-kit/app";
import "@veer/studio-kit/app/styles.css";
import type { ProbeUi } from "../src/ui-types";
import ProbePage from "./ProbePage";

mountStudioApp<ProbeUi>({
  appName: "Probe",
  render: (host) => <ProbePage host={host} />,
});
