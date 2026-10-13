import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioErrorBoundary, applyAppTheme, errorMessage, useMutation, usePolled } from "../../app/index.js";

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

describe("usePolled", () => {
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
        <button onClick={async () => setResult(String(await mutation.run(async () => "saved")))}>
          {mutation.error ?? result}
        </button>
      );
    }
    await act(async () => root.render(<Form />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("saved");

    await act(async () => { await mutation.run(async () => { throw new Error("Error: nope"); }); });
    expect(container.textContent).toBe("nope");
    expect(mutation.pending).toBe(false);
  });
});
