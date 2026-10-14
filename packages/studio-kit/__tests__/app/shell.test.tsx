import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperAppTheme, GatekeeperAppThemeReceiver } from "@gadgets/workshop-shared/theme";
import {
  StudioErrorBoundary,
  applyAppTheme,
  errorMessage,
  mountStudioApp,
  useMutation,
  usePolled,
  type FlatUi,
  type StudioAppHost,
} from "../../app/index.js";

// React's act() needs to know it runs in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.removeAttribute("style");
});

describe("applyAppTheme", () => {
  it("applies the host's mode and accent, and clears the accent", () => {
    applyAppTheme({ mode: "dark", accentColor: "#3b82f6" });
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand")).toContain("#3b82f6");

    applyAppTheme({ mode: "light", accentColor: null });
    expect(document.documentElement.dataset.mode).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand")).toBe("");
  });
});

describe("errorMessage", () => {
  it("shows the gate's own message without RPC prefixes", () => {
    expect(errorMessage(new Error("Error: Note can't be empty."))).toBe("Note can't be empty.");
    expect(errorMessage(new TypeError("TypeError: Error: bad"))).toBe("bad");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(undefined)).toBe("Something went wrong. Try again.");
  });
});

describe("StudioErrorBoundary", () => {
  it("recovers by rendering again, never by reloading the frame", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    function Flaky() {
      if (fail) throw new Error("boom");
      return <p>recovered</p>;
    }
    act(() => root.render(<StudioErrorBoundary appName="Probe"><Flaky /></StudioErrorBoundary>));
    expect(container.textContent).toContain("Probe hit a problem.");

    fail = false;
    act(() => container.querySelector("button")!.click());
    expect(container.textContent).toBe("recovered");
  });
});

describe("mountStudioApp", () => {
  type PingUi = { ping(): Promise<string> };

  class FakeUi extends RpcTarget {
    ping(): string {
      return "pong";
    }
  }

  /** Stands in for the Workshop's GatekeeperAppHostImpl on the other end of the port. */
  class FakeHost extends RpcTarget {
    receiver: RpcStub<GatekeeperAppThemeReceiver> | null = null;
    get ui() {
      return new FakeUi();
    }
    subscribeTheme(receiver: RpcStub<GatekeeperAppThemeReceiver>): GatekeeperAppTheme {
      this.receiver = receiver.dup();
      return { mode: "dark", accentColor: null };
    }
  }

  function Pinger({ host }: { host: StudioAppHost<PingUi> }) {
    const [reply, setReply] = useState("none");
    return <button onClick={async () => setReply(await host.ui.ping())}>{reply}</button>;
  }

  it("handshakes once, follows the host's theme, and reaches the ui", async () => {
    const element = document.createElement("div");
    element.id = "root";
    document.body.append(element);
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    const host = new FakeHost();
    try {
      await act(async () => mountStudioApp<PingUi>({ appName: "Test", render: (h) => <Pinger host={h} /> }));
      expect(post).toHaveBeenCalledTimes(1);
      const [message, origin, transfer] = post.mock.calls[0] as unknown as [unknown, string, MessagePort[]];
      expect(message).toEqual({ type: "handshake" });
      expect(origin).toBe("*");
      newMessagePortRpcSession(transfer[0], host);

      await vi.waitFor(() => expect(document.documentElement.dataset.mode).toBe("dark"));
      await act(async () => host.receiver!.setTheme({ mode: "light", accentColor: "#3b82f6" }));
      await vi.waitFor(() => expect(document.documentElement.dataset.mode).toBe("light"));

      await act(async () => element.querySelector("button")!.click());
      await vi.waitFor(() => expect(element.textContent).toBe("pong"));
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      post.mockRestore();
      element.remove();
    }
  });
});

describe("FlatUi", () => {
  it("accepts methods only, at the top level", () => {
    type Flat = { list(): Promise<string[]>; add(body: string): Promise<void> };
    type Nested = { list(): Promise<string[]>; notes: { add(body: string): Promise<void> } };
    const flat: FlatUi<Flat> = {} as Flat;
    // @ts-expect-error -- `notes` is an object, which the host's rate limiter cannot forward.
    const nested: FlatUi<Nested> = {} as Nested;
    expect([flat, nested]).toHaveLength(2);
  });
});

describe("usePolled", () => {
  it("drops a response that arrives after a newer request", async () => {
    const resolvers: ((value: string) => void)[] = [];
    let refresh: () => Promise<void> = async () => {};
    function Slow() {
      const polled = usePolled(() => new Promise<string>((resolve) => resolvers.push(resolve)), {
        intervalMs: 0,
      });
      refresh = polled.refresh;
      return <p>{polled.data ?? "loading"}</p>;
    }
    await act(async () => root.render(<Slow />));
    act(() => void refresh());
    // The newer request answers first; the older one's late answer must not overwrite it.
    await act(async () => resolvers[1]("fresh"));
    await act(async () => resolvers[0]("stale"));
    expect(container.textContent).toBe("fresh");
  });

  it("loads, then reloads on refresh", async () => {
    let calls = 0;
    const load = vi.fn(async () => ++calls);
    let refresh: () => Promise<void> = async () => {};
    function Counter() {
      const polled = usePolled(load, { intervalMs: 0 });
      refresh = polled.refresh;
      return <p>{polled.loading ? "loading" : `value ${polled.data}`}</p>;
    }
    await act(async () => root.render(<Counter />));
    expect(container.textContent).toBe("value 1");
    await act(async () => refresh());
    expect(container.textContent).toBe("value 2");
  });

  it("reports a failed load", async () => {
    function Broken() {
      const polled = usePolled(async () => { throw new Error("Error: offline"); }, { intervalMs: 0 });
      return <p>{polled.error ?? "ok"}</p>;
    }
    await act(async () => root.render(<Broken />));
    expect(container.textContent).toBe("offline");
  });
});

describe("useMutation", () => {
  it("records pending state and failures", async () => {
    let mutation!: ReturnType<typeof useMutation>;
    function Form() {
      mutation = useMutation();
      const [result, setResult] = useState<string>("none");
      return (
        <button onClick={async () => {
          const outcome = await mutation.run(async () => "saved");
          setResult(outcome.ok ? outcome.value : "failed");
        }}>
          {mutation.error ?? result}
        </button>
      );
    }
    await act(async () => root.render(<Form />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("saved");

    let outcome: Awaited<ReturnType<typeof mutation.run>> | undefined;
    await act(async () => { outcome = await mutation.run(async () => { throw new Error("Error: nope"); }); });
    expect(outcome).toEqual({ ok: false });
    expect(container.textContent).toBe("nope");
    expect(mutation.pending).toBe(false);

    // A write that resolves to nothing still succeeds.
    await act(async () => { outcome = await mutation.run(async () => undefined); });
    expect(outcome).toEqual({ ok: true, value: undefined });
  });
});
