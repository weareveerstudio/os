/**
 * The Probe Gatekeeper facet: one per workspace, installed by the Workshop as the ambient Probe
 * capsule. It owns the workspace's action journal (facet storage) and hands the agent a
 * `ProbeSession`. Reads come from the studio-wide store, with this workspace's pending notes folded
 * in; writes are staged as auto-approvable actions and applied to the store once approved.
 */

import { DurableObject, RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  ActionJournal,
  defineActions,
  type ActionSubmitter,
  type BoundActionSet,
  type JournalEntry,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import {
  createSimulationView,
  replaySimulation,
  type SimulationStep,
} from "@gadgets/gatekeeper-kit/simulation";
import type {
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { actionKind, agentWrite, operationId } from "@veer/studio-kit/actions";
import { requireId } from "@veer/studio-kit/guards";
import {
  BASELINE,
  ObservationGate,
  observation,
  openObservers,
} from "@veer/studio-kit/observers";
import { sharedStore } from "@veer/studio-kit/stores";
import { requireNoteBody, type ProbeNotesStore, type StoredNote } from "./store.js";
import type { ProbeNote, ProbeSession } from "./types.js";
import TYPES_CODE from "./types.txt";

/** What `getSingletonGatekeeperClass()` imbues the facet with. */
export type ProbeFacetProps = { accountId: string };

/**
 * The agent's actions and their payloads. A note's id is minted at submit and doubles as the
 * write's operation id: unique, and kept in the payload.
 */
export type ProbeActions = {
  addNote: { noteId: string; body: string; queuedAt: number };
};

type ProbeHost = {
  workspaceId: string;
  accountId: string;
  store(): DurableObjectStub<ProbeNotesStore>;
};

type PendingAction = JournalEntry<TaggedAction<ProbeActions>>;

export const ADD_NOTE_KIND: ActionKind = actionKind("probe", "add-note", "Add a Probe note");

const actions = defineActions<ProbeHost, ProbeActions>({
  addNote: agentWrite({
    kind: ADD_NOTE_KIND,
    describe: (payload) => ({
      title: "Add a Probe note",
      ...buildDescription(
        "Adds a note to the studio's shared Probe notes, signed as written by an agent from this " +
        "workspace. Everyone in the studio can read it.")
        .inline("Note ID", payload.noteId)
        .verbatim("Note", payload.body)
        .finish(),
      implementsRevert: false,
    }),
    apply: async (payload, host) => {
      await host.store().applyAgentNote({
        noteId: payload.noteId,
        body: payload.body,
        accountId: host.accountId,
        workspaceId: host.workspaceId,
      });
    },
  }),
}, {
  // No provider connection, so no authority can change under a queued action.
  fence: "none",
  vendorId: "veer-probe",
});

/**
 * Converts a stored note for the agent.
 * @param note The stored note.
 * @returns The agent's view of it.
 */
export function toProbeNote(note: StoredNote): ProbeNote {
  return {
    id: note.id,
    body: note.body,
    createdAt: new Date(note.createdAt).toISOString(),
    author: note.author.kind === "person"
      ? { kind: "person", name: note.author.name }
      : { kind: "agent", workspaceId: note.author.workspaceId },
    archived: note.archivedAt !== null,
    pending: false,
  };
}

function pendingNote(payload: ProbeActions["addNote"], workspaceId: string): ProbeNote {
  return {
    id: payload.noteId,
    body: payload.body,
    createdAt: new Date(payload.queuedAt).toISOString(),
    author: { kind: "agent", workspaceId },
    archived: false,
    pending: true,
  };
}

/**
 * Folds this workspace's queued notes over the store's, newest first. A queued note whose id the
 * store already holds was applied while the journal still listed it, so it adds nothing.
 * @param stored Notes from the store, newest first.
 * @param pending The journal's pending actions.
 * @param workspaceId This facet's workspace.
 * @returns The simulated notes.
 */
export function simulateNotes(
  stored: readonly ProbeNote[],
  pending: readonly PendingAction[],
  workspaceId: string,
): ProbeNote[] {
  const view = createSimulationView(pending, () => ["notes"]);
  const result = replaySimulation<ProbeNote[], PendingAction>(
    [...stored],
    view.all(),
    (notes, record): SimulationStep<ProbeNote[]> => {
      const { action } = record;
      if (action.kind !== "addNote") {
        return { kind: "unsupported", reason: `Unknown queued action ${String(action.kind)}.` };
      }
      if (notes.some((note) => note.id === action.payload.noteId)) return { kind: "known-no-effect" };
      return { kind: "applied", value: [pendingNote(action.payload, workspaceId), ...notes] };
    },
  );
  // Only one kind exists, so an incomplete replay means a kind this deploy dropped: its record
  // fails at apply and stops projecting, so the partial view is the honest one.
  return result.kind === "complete" ? result.value : result.partial;
}

type SessionDependencies = {
  workspaceId: string;
  queue: ActionSubmitter & Disposable;
  gate: ObservationGate;
  submitNote(queue: ActionSubmitter, payload: ProbeActions["addNote"]): Promise<number>;
  pending(): PendingAction[];
  store: DurableObjectStub<ProbeNotesStore>;
  now?: () => number;
};

/** The agent's `ProbeSession`. Every read is authorized as an observation before it returns. */
@validateRpc()
export class ProbeSessionImpl extends RpcTarget implements ProbeSession {
  readonly #deps: SessionDependencies;

  constructor(dependencies: SessionDependencies) {
    super();
    this.#deps = dependencies;
  }

  async listNotes(options?: { includeArchived?: boolean }): Promise<ProbeNote[]> {
    const { store, gate, workspaceId } = this.#deps;
    const stored = await store.listNotes({ includeArchived: options?.includeArchived === true });
    const notes = simulateNotes(stored.map(toProbeNote), this.#deps.pending(), workspaceId);
    await gate.authorize(
      observation("List Probe notes", `Listed ${notes.length} Probe notes.`),
      BASELINE);
    return notes;
  }

  async getNote(id: string): Promise<ProbeNote | null> {
    requireId(id, "Note ID");
    const { store, gate, workspaceId } = this.#deps;
    const stored = await store.getNote(id);
    const note = simulateNotes(stored ? [toProbeNote(stored)] : [], this.#deps.pending(), workspaceId)
      .find((candidate) => candidate.id === id) ?? null;
    // Authorized either way: an answer of "no such note" is still a read of the store.
    await gate.authorize(
      observation(
        "Read a Probe note",
        note ? "Read one Probe note." : "Looked for a Probe note that does not exist.",
        (fields) => fields.inline("Note ID", id)),
      BASELINE);
    return note;
  }

  async addNote(body: string): Promise<ProbeNote> {
    const payload = {
      noteId: operationId(),
      body: requireNoteBody(body),
      queuedAt: (this.#deps.now ?? Date.now)(),
    };
    await this.#deps.submitNote(this.#deps.queue, payload);
    return pendingNote(payload, this.#deps.workspaceId);
  }

  [Symbol.dispose](): void {
    this.#deps.gate[Symbol.dispose]();
    this.#deps.queue[Symbol.dispose]();
  }
}

/** The per-workspace facet. */
@validateRpc()
export class ProbeGatekeeper
  extends DurableObject<Cloudflare.Env, ProbeFacetProps>
  implements Gatekeeper<ProbeSession>
{
  readonly #journal = new ActionJournal<TaggedAction<ProbeActions>>(this.ctx.storage.kv, {
    namespace: "probe",
  });
  readonly #observers = openObservers();
  readonly #host: ProbeHost = {
    workspaceId: this.ctx.id.toString(),
    accountId: this.ctx.props.accountId,
    store: () => sharedStore(this.ctx.exports.ProbeNotesStore),
  };
  #bound?: BoundActionSet<ProbeActions>;

  #actions(): BoundActionSet<ProbeActions> {
    return this.#bound ??= actions.bind(this.#journal, this.#host);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "veer-studio://probe/notes",
      title: "Probe notes",
      snippet: "The studio's shared Probe notes: list, read and add notes.",
      suggestedBindingName: "PROBE",
      tsType: "ProbeSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions().autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ProbeSession> {
    const workspaceId = this.#host.workspaceId;
    // A smoke check only: the facet inherits its parent's id, which is the workspace's.
    if (!workspaceId || workspaceId === this.ctx.props.accountId) {
      throw new Error("Invalid inherited Probe workspace scope.");
    }
    return new ProbeSessionImpl({
      workspaceId,
      queue: approvalQueue.dup(),
      gate: new ObservationGate(approvalQueue.dup(), this.#observers),
      submitNote: (queue, payload) => this.#actions().submit(queue, "addNote", payload),
      pending: () => this.#journal.listPending(),
      store: this.#host.store(),
    });
  }

  /** No discovery index: the agent lists notes through the session. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Open observers: studio data carries no access distinction between studio members. */
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    return this.#observers.addObserver(id, user);
  }

  removeObserver(id: string): Promise<void> {
    return this.#observers.removeObserver(id);
  }

  applyAction(action: number): Promise<void> {
    return this.#actions().apply(action);
  }

  async rejectAction(action: number): Promise<void> {
    await this.#actions().reject(action);
  }

  async revertAction(_action: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message: "Probe notes can't be removed by reverting. Archive the note in the Probe app instead.",
      canRetry: false,
    };
  }
}
