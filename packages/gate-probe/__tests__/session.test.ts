import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { FakeApprovalQueue, rejectionMessage, type FacetSpec } from "@veer/studio-kit/testing";
import { SHARED_STORE_NAME } from "@veer/studio-kit/stores";
import { describe, expect, it } from "vitest";
import { ADD_NOTE_KIND } from "../src/gatekeeper.js";
import type { ProbeSession } from "../src/types.js";

const spec: FacetSpec = { className: "ProbeGatekeeper", props: { accountId: "acct-owner" } };

function workspace(name: string) {
  return env.FACET_HOST.getByName(name);
}

function store() {
  return env.NOTES_STORE.getByName(SHARED_STORE_NAME);
}

async function open(name: string) {
  const host = workspace(name);
  const queue = new FakeApprovalQueue();
  const session = await host.startSession(spec, queue) as unknown as ProbeSession;
  return { host, queue, session, workspaceId: await host.workspaceId() };
}

describe("ProbeGatekeeper", () => {
  it("describes the ambient Probe binding", async () => {
    const host = workspace("describe");
    expect(await host.describe(spec)).toMatchObject({ tsType: "ProbeSession", suggestedBindingName: "PROBE" });
    expect(await host.getTypeScriptTypes(spec)).toContain("export interface ProbeSession");
    expect(await host.getAutoApprovableActions(spec)).toEqual([ADD_NOTE_KIND]);
    expect(await host.getAgentCatalog(spec)).toBeNull();
    expect(await host.revertAction(spec, 1)).toMatchObject({ canRetry: false });
  });

  it("admits every observer", async () => {
    const verifier = (createExecutionContext().exports as unknown as {
      ProbeVerifier(options: object): Fetcher;
    }).ProbeVerifier({});
    const host = workspace("observers");
    await expect(host.addObserver(spec, "collaborator-1", verifier as never)).resolves.toBeUndefined();
    await expect(host.removeObserver(spec, "collaborator-1")).resolves.toBeUndefined();
  });
});

describe("ProbeSession", () => {
  it("submits an auto-approvable note described with typed fields", async () => {
    const { queue, session, workspaceId } = await open("submit");
    const note = await session.addNote("  Hello from an agent  ");

    expect(note).toMatchObject({
      body: "Hello from an agent",
      author: { kind: "agent", workspaceId },
      archived: false,
      pending: true,
    });
    expect(queue.submissions).toHaveLength(1);
    const { description } = queue.submissions[0];
    expect(description).toMatchObject({
      title: "Add a Probe note",
      autoApprovable: true,
      actionKind: ADD_NOTE_KIND,
      descriptionIsComplete: true,
      implementsRevert: false,
    });
    // Continue-with-simulation: the agent is not told to wait.
    expect(description.awaitDecision).toBeUndefined();
    expect(description.fields).toEqual([
      { kind: "inline", label: "Note ID", value: note.id },
      expect.objectContaining({ kind: "text", label: "Note", value: "Hello from an agent" }),
    ]);
    // The agent's text is in a field, never in the prose.
    expect(description.description).not.toContain("Hello from an agent");
  });

  it("shows a pending note to this workspace before it is approved", async () => {
    const { queue, session } = await open("simulate");
    const note = await session.addNote("Not approved yet");

    const listed = await session.listNotes();
    expect(listed.find((candidate) => candidate.id === note.id)).toMatchObject({ pending: true });
    expect(await session.getNote(note.id)).toMatchObject({ id: note.id, pending: true });
    expect(await store().getNote(note.id)).toBeNull();

    // Every read was authorized as an observation, after the fact and with values in fields.
    expect(queue.observations.map((observation) => observation.title))
      .toEqual(["List Probe notes", "Read a Probe note"]);
    expect(queue.observations[1].fields).toEqual([{ kind: "inline", label: "Note ID", value: note.id }]);
  });

  it("keeps a workspace's pending notes to that workspace", async () => {
    const { session } = await open("isolation-a");
    const note = await session.addNote("Only in workspace A until approved");
    const other = await open("isolation-b");
    expect((await other.session.listNotes()).map((listed) => listed.id)).not.toContain(note.id);
    expect(await other.session.getNote(note.id)).toBeNull();
  });

  it("applies an approved note to the shared store, once", async () => {
    const { host, queue, session, workspaceId } = await open("apply");
    const note = await session.addNote("Approved note");
    const actionId = queue.submissions[0].action;

    await host.applyAction(spec, actionId);
    expect(await store().getNote(note.id)).toMatchObject({
      body: "Approved note",
      author: { kind: "agent", accountId: "acct-owner", workspaceId },
    });
    const listed = (await session.listNotes()).filter((candidate) => candidate.id === note.id);
    expect(listed).toEqual([expect.objectContaining({ pending: false })]);

    // A replay, as after a lost reply, writes nothing more.
    await host.applyAction(spec, actionId);
    await store().applyAgentNote({
      noteId: note.id, body: "Approved note", accountId: "acct-owner", workspaceId,
    });
    const audit = await store().listAudit({ limit: 200 });
    expect(audit.entries.filter((entry) => entry.target === note.id)).toEqual([
      expect.objectContaining({
        action: "note.add",
        actor: { kind: "agent", accountId: "acct-owner", workspaceId },
      }),
    ]);
  });

  it("applies notes from a re-created capsule whose action ids start again at 1", async () => {
    // Disabling and re-enabling the gate, or removing and re-adding an account, gives the workspace
    // a new capsule: same workspace id, empty journal, action ids from 1 again.
    const host = workspace("recreated");
    const first = new FakeApprovalQueue();
    const before = await (await host.startSession(spec, first) as unknown as ProbeSession)
      .addNote("From the first capsule");
    await host.applyAction(spec, first.submissions[0].action);

    const recreated: FacetSpec = { ...spec, name: "gatekeeper7" };
    const second = new FakeApprovalQueue();
    const after = await (await host.startSession(recreated, second) as unknown as ProbeSession)
      .addNote("From the re-created capsule");
    expect(second.submissions[0].action).toBe(first.submissions[0].action);
    await host.applyAction(recreated, second.submissions[0].action);

    expect(await store().getNote(before.id)).toMatchObject({ body: "From the first capsule" });
    expect(await store().getNote(after.id)).toMatchObject({ body: "From the re-created capsule" });
  });

  it("drops a rejected note", async () => {
    const { host, queue, session } = await open("reject");
    const note = await session.addNote("Rejected note");
    await host.rejectAction(spec, queue.submissions[0].action);
    expect((await session.listNotes()).map((listed) => listed.id)).not.toContain(note.id);
    expect(await store().getNote(note.id)).toBeNull();
  });

  it("authorizes a lookup that finds nothing", async () => {
    const { queue, session } = await open("missing");
    expect(await session.getNote(crypto.randomUUID())).toBeNull();
    expect(queue.observations[0].description).toContain("does not exist");
  });

  it("refuses bad input without submitting or reading", async () => {
    const { queue, session } = await open("refusals");
    expect(await rejectionMessage(() => session.addNote(" "))).toMatch(/Note can't be empty/);
    expect(await rejectionMessage(() => session.getNote("../notes"))).toMatch(/not a valid id/);
    expect(queue.submissions).toEqual([]);
    expect(queue.observations).toEqual([]);
  });

  it("returns nothing when the overseer refuses a read", async () => {
    const { queue, session } = await open("refused");
    queue.refuseNextObservation();
    expect(await rejectionMessage(() => session.listNotes())).toMatch(/refused/);
  });
});
