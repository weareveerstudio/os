/**
 * The app shell every studio gate's sidebar app mounts through.
 *
 * The app runs in a sandboxed, opaque-origin iframe (`allow-scripts allow-modals`): no popups, no
 * downloads, no top navigation, and its own CSP sets `connect-src 'none'`. Everything it reads or
 * writes goes through the host's message port: the gate's flat `ui` capability, the theme, and a few
 * navigation helpers. The host accepts exactly one handshake per mount, so the app must never reload
 * itself; the error boundary below recovers by re-rendering instead.
 */

import { Button, Toasty, TooltipProvider } from "@cloudflare/kumo";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import { applyAppTheme } from "./theme.js";
import type { UiClient } from "./ui-client.js";

export { applyAppTheme } from "./theme.js";
export { errorMessage, type FlatUi, type UiClient } from "./ui-client.js";
export {
  useMutation,
  usePolled,
  type Mutation,
  type MutationResult,
  type Polled,
} from "./hooks.js";

/** What `setPresenting` resolves with: where the host placed the overlay, if anywhere. */
export type PresentAck = {
  rect: { left: number; top: number; width: number; height: number } | null;
  willResize: boolean;
};

/** The host's capability, as the Workshop's `GatekeeperAppHostImpl` exposes it. */
interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<RpcTarget>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
  setPresenting(active: boolean): Promise<PresentAck>;
}

/** What a gate's app receives. */
export type StudioAppHost<Ui> = {
  /** The gate's flat `ui` capability. */
  ui: UiClient<Ui>;
  /** Navigates the Workshop to a workspace (64-hex id), optionally to one gadget. */
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  /** Live titles for up to 100 workspace ids; null for one the viewer can't see. */
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  /** Prefills the Home launcher's composer with `prompt` (at most 4000 characters). */
  openPrompt(prompt: string): Promise<void>;
  /** Grows the frame to a full-viewport overlay for a modal, or restores it. */
  setPresenting(active: boolean): Promise<PresentAck>;
};

class ThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
  }
}

type BoundaryProps = { appName: string; children: ReactNode };

/** Catches render errors and offers to render again. Never reloads the frame (see above). */
export class StudioErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`${this.props.appName} app crashed`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-base font-semibold">{this.props.appName} hit a problem.</p>
        <Button variant="secondary" onClick={() => this.setState({ failed: false })}>
          Try again
        </Button>
      </main>
    );
  }
}

/** The Kumo providers and error boundary every studio app renders inside. */
export function StudioAppFrame({ appName, children }: BoundaryProps) {
  return (
    <StudioErrorBoundary appName={appName}>
      <TooltipProvider>
        <Toasty>{children}</Toasty>
      </TooltipProvider>
    </StudioErrorBoundary>
  );
}

/**
 * Connects to the host and renders the app.
 * @param options `appName` labels errors; `render` receives the host and returns the page.
 */
export function mountStudioApp<Ui>(options: {
  appName: string;
  render(host: StudioAppHost<Ui>): ReactNode;
}): void {
  const element = document.getElementById("root");
  if (!element) throw new Error(`${options.appName}: missing #root element.`);

  const { port1, port2 } = new MessageChannel();
  // An opaque-origin frame can't name its parent's origin. The host accepts this handshake only from
  // this frame with a null origin, and the message carries nothing but the private port.
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const receiver = new ThemeReceiver();
  const host = newMessagePortRpcSession<HostCapability>(port1, receiver);
  host.subscribeTheme(receiver).then(applyAppTheme).catch(() => {});

  const studioHost: StudioAppHost<Ui> = {
    ui: host.ui as unknown as UiClient<Ui>,
    openWorkspace: (workspaceId, gadgetId) => host.openWorkspace(workspaceId, gadgetId),
    resolveWorkspaceTitles: (ids) => host.resolveWorkspaceTitles(ids),
    openPrompt: (prompt) => host.openPrompt(prompt),
    setPresenting: (active) => host.setPresenting(active),
  };

  createRoot(element).render(
    <StudioAppFrame appName={options.appName}>{options.render(studioHost)}</StudioAppFrame>,
  );
}
