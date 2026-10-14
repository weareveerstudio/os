import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StudioAppHost } from "@veer/studio-kit/app";
import type { AuditEntry } from "@veer/studio-kit/audit-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProbePage, { formatWhen, mergeAudit, snippet } from "../../app/ProbePage";
import type { ProbeNoteView, ProbeUi, ProbeViewer } from "../../src/ui-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT_WORKSPACE = "a".repeat(64);

/** An in-memory `ui` with the Worker's rules: a name before edits, admins-only audit. */
function fakeHost(viewer: ProbeViewer, notes: ProbeNoteView[] = []) {
  const audit: AuditEntry[] = [];
  const person = () => ({ kind: "person" as const, accountId: "acct", name: viewer.displayName!, isAdmin: viewer.isAdmin });
  const ui: ProbeUi = {
    getViewer: async () => ({ ...viewer }),
    setDisplayName: async (name) => {
      viewer.displayName = name.trim();
      return { ...viewer };
    },
    listNotes: async (options) =>
      notes.filter((note) => options?.includeArchived || note.archivedAt === null),
    addNote: async (body) => {
      if (!viewer.displayName) throw new Error("Error: Set your display name before making changes.");
      const note: ProbeNoteView = {
        id: crypto.randomUUID(), body, createdAt: Date.now(),
        author: { kind: "person", name: viewer.displayName }, archivedAt: null, archivedBy: null,
      };
      notes.unshift(note);
      audit.unshift({ seq: audit.length + 1, at: Date.now(), actor: person(), action: "note.add", target: note.id, detail: null });
      return note;
    },
    archiveNote: async (id) => {
      const note = notes.find((candidate) => candidate.id === id)!;
      note.archivedAt = Date.now();
      note.archivedBy = viewer.displayName;
      return note;
    },
    listAuditLog: async (options) => {
      if (!viewer.isAdmin) throw new Error("The audit log is available to admins only.");
      const limit = options?.limit ?? 50;
      const older = audit.filter((entry) => options?.before === undefined || entry.seq < options.before);
      const entries = older.slice(0, limit);
      return older.length > limit ? { entries, nextBefore: entries.at(-1)!.seq } : { entries };
    },
  };
  const host: StudioAppHost<ProbeUi> = {
    ui,
    openWorkspace: vi.fn(async () => {}),
    resolveWorkspaceTitles: vi.fn(async (ids: string[]) => ids.map(() => "Launch plan")),
    openPrompt: vi.fn(async () => {}),
    setPresenting: vi.fn(async () => ({ rect: null, willResize: false })),
  };
  return { host, ui, notes, audit };
}

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
});

async function render(host: StudioAppHost<ProbeUi>) {
  await act(async () => root.render(<ProbePage host={host} />));
  // Let the first loads settle.
  await act(async () => {});
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`No "${label}" button in: ${container.textContent}`);
  return found;
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ProbePage", () => {
  it("asks for a display name before allowing notes", async () => {
    const { host } = fakeHost({ isAdmin: false, displayName: null });
    await render(host);
    expect(container.textContent).toContain("Set a display name to add or archive notes.");
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    expect(button("Add note").disabled).toBe(true);

    await act(async () => type(container.querySelector("input")!, "Ada"));
    await act(async () => button("Save").click());
    await act(async () => {});
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(container.textContent).not.toContain("Set a display name");
  });

  it("adds a note and shows it signed with the display name", async () => {
    const { host, notes } = fakeHost({ isAdmin: false, displayName: "Ada" });
    await render(host);
    await act(async () => type(container.querySelector("textarea")!, "Ship the probe"));
    await act(async () => button("Add note").click());
    await act(async () => {});
    expect(notes).toHaveLength(1);
    expect(container.textContent).toContain("Ship the probe");
    expect(container.textContent).toContain("Ada");
    expect(container.querySelector("textarea")!.value).toBe("");
  });

  it("archives a note", async () => {
    const { host, notes } = fakeHost({ isAdmin: false, displayName: "Ada" }, [{
      id: crypto.randomUUID(), body: "Old note", createdAt: Date.now() - 60_000,
      author: { kind: "person", name: "Ada" }, archivedAt: null, archivedBy: null,
    }]);
    await render(host);
    await act(async () => button("Archive").click());
    await act(async () => {});
    expect(notes[0].archivedBy).toBe("Ada");
    expect(container.textContent).not.toContain("Old note");
  });

  it("names agent notes by their workspace's live title and opens it", async () => {
    const { host } = fakeHost({ isAdmin: false, displayName: "Ada" }, [{
      id: crypto.randomUUID(), body: "From an agent", createdAt: Date.now(),
      author: { kind: "agent", workspaceId: AGENT_WORKSPACE }, archivedAt: null, archivedBy: null,
    }]);
    await render(host);
    expect(host.resolveWorkspaceTitles).toHaveBeenCalledWith([AGENT_WORKSPACE]);
    await act(async () => button("Launch plan").click());
    expect(host.openWorkspace).toHaveBeenCalledWith(AGENT_WORKSPACE);
  });

  it("shows the audit log to admins only", async () => {
    const member = fakeHost({ isAdmin: false, displayName: "Ada" });
    await render(member.host);
    expect(container.textContent).toContain("Member");
    expect(container.textContent).not.toContain("Audit log");

    act(() => root.unmount());
    root = createRoot(container);
    const admin = fakeHost({ isAdmin: true, displayName: "Audrey" });
    await render(admin.host);
    expect(container.textContent).toContain("Admin");
    expect(container.textContent).toContain("Audit log");
    await act(async () => type(container.querySelector("textarea")!, "Logged"));
    await act(async () => button("Add note").click());
    await act(async () => {});
    expect(container.textContent).toContain("Audrey added a note");
  });
});

describe("ProbePage, admin views", () => {
  function seedAudit(audit: AuditEntry[], count: number) {
    for (let seq = 1; seq <= count; seq++) {
      audit.unshift({
        seq, at: Date.now() - (count - seq) * 1000,
        actor: { kind: "person", accountId: "acct", name: "Audrey", isAdmin: true },
        action: "note.add", target: `n${seq}`, detail: { body: `Note number ${seq}` },
      });
    }
  }

  it("keeps older audit pages across polls", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const admin = fakeHost({ isAdmin: true, displayName: "Audrey" });
      seedAudit(admin.audit, 40);
      await render(admin.host);
      expect(container.querySelectorAll("li").length).toBe(25);
      await act(async () => button("Load older").click());
      await act(async () => {});
      expect(container.textContent).toContain("Note number 1");
      // A poll of the head page must not drop what was paged in.
      await act(async () => { vi.advanceTimersByTime(16_000); });
      await act(async () => {});
      expect(container.textContent).toContain("Note number 1");
      expect(container.textContent).toContain("Note number 40");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows what changed, and who", async () => {
    const admin = fakeHost({ isAdmin: true, displayName: "Audrey" });
    seedAudit(admin.audit, 1);
    await render(admin.host);
    expect(container.textContent).toContain("Audrey added a note");
    expect(container.textContent).toContain("“Note number 1”");
  });
});

describe("ProbePage, resilience", () => {
  const agentNote = (): ProbeNoteView => ({
    id: crypto.randomUUID(), body: "From an agent", createdAt: Date.now(),
    author: { kind: "agent", workspaceId: AGENT_WORKSPACE }, archivedAt: null, archivedBy: null,
  });

  it("still links an agent's workspace when its title can't be looked up", async () => {
    const { host } = fakeHost({ isAdmin: false, displayName: "Ada" }, [agentNote()]);
    host.resolveWorkspaceTitles = vi.fn(async () => { throw new Error("lookup failed"); });
    await render(host);
    expect(container.textContent).not.toContain("can't open");
    await act(async () => button("Open workspace").click());
    expect(host.openWorkspace).toHaveBeenCalledWith(AGENT_WORKSPACE);
  });

  it("says a workspace can't be opened only when the host says so", async () => {
    const { host } = fakeHost({ isAdmin: false, displayName: "Ada" }, [agentNote()]);
    host.resolveWorkspaceTitles = vi.fn(async (ids: string[]) => ids.map(() => null));
    await render(host);
    expect(container.textContent).toContain("a workspace you can't open");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Open workspace")).toBe(false);
  });

  it("retries a failed first load without reloading the frame", async () => {
    const { host, ui } = fakeHost({ isAdmin: false, displayName: "Ada" });
    const getViewer = ui.getViewer;
    let fail = true;
    ui.getViewer = async () => {
      if (fail) throw new Error("Error: offline");
      return getViewer();
    };
    await render(host);
    expect(container.textContent).toContain("offline");
    fail = false;
    await act(async () => button("Try again").click());
    await act(async () => {});
    expect(container.textContent).toContain("Member");
  });
});

describe("helpers", () => {
  it("shortens a note to its first line", () => {
    expect(snippet("first line\nsecond")).toBe("first line");
    expect(snippet("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });

  it("merges audit pages by seq, newest first", () => {
    const entry = (seq: number): AuditEntry => ({
      seq, at: seq, actor: { kind: "agent", accountId: "a", workspaceId: "w" }, action: "note.add",
      target: null, detail: null,
    });
    expect(mergeAudit([entry(3), entry(2)], [entry(2), entry(1)]).map((e) => e.seq)).toEqual([3, 2, 1]);
  });
});

describe("formatWhen", () => {
  it("is relative within a week and a date beyond", () => {
    const now = Date.UTC(2026, 9, 13, 12);
    expect(formatWhen(now - 30_000, now)).toMatch(/seconds? ago/);
    expect(formatWhen(now - 3 * 60_000, now)).toBe("3 minutes ago");
    expect(formatWhen(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(formatWhen(now - 30 * 86_400_000, now)).toBe(new Date(now - 30 * 86_400_000).toLocaleDateString());
  });
});
