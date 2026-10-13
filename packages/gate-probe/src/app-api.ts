/**
 * The Probe app's `ui` capability. One instance per app mount, created by `startAppUi()` with the
 * mount's account and admin status. Human edits apply immediately and are written to the audit log
 * in the same transaction; the Workshop neither audits nor approves this path.
 */

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { normalizeDisplayName, type StudioAccountState } from "@veer/studio-kit/account-state";
import type { AuditPage } from "@veer/studio-kit/audit-log";
import type { FlatUi } from "@veer/studio-kit/app/ui-client";
import { requireAdmin } from "@veer/studio-kit/guards";
import type { PersonActor, ProbeNotesStore, StoredNote } from "./store.js";
import type { ProbeNoteView, ProbeUi, ProbeViewer } from "./ui-types.js";

export type ProbeAppDependencies = {
  accountId: string;
  isAdmin: boolean;
  state: DurableObjectStub<StudioAccountState>;
  store: DurableObjectStub<ProbeNotesStore>;
};

/**
 * Converts a stored note for the app. People are shown by name only; the account id stays in the
 * audit log.
 * @param note The stored note.
 * @returns The app's view of it.
 */
export function toNoteView(note: StoredNote): ProbeNoteView {
  return {
    id: note.id,
    body: note.body,
    createdAt: note.createdAt,
    author: note.author.kind === "person"
      ? { kind: "person", name: note.author.name }
      : { kind: "agent", workspaceId: note.author.workspaceId },
    archivedAt: note.archivedAt,
    archivedBy: note.archivedBy,
  };
}

@validateRpc()
export class ProbeAppApi extends RpcTarget implements FlatUi<ProbeUi> {
  readonly #deps: ProbeAppDependencies;

  constructor(dependencies: ProbeAppDependencies) {
    super();
    this.#deps = dependencies;
  }

  async getViewer(): Promise<ProbeViewer> {
    const { displayName } = await this.#deps.state.getProfile();
    return { isAdmin: this.#deps.isAdmin, displayName };
  }

  async setDisplayName(name: string): Promise<ProbeViewer> {
    const { state, store, accountId, isAdmin } = this.#deps;
    const next = normalizeDisplayName(name);
    const previous = (await state.getProfile()).displayName;
    if (next === previous) return { isAdmin, displayName: previous };
    // Audited first: the name and its audit row live in different Durable Objects, so they cannot
    // commit together. A failure after this row leaves a retry that records it again, never a change
    // with no record.
    await store.recordNameChange({ kind: "person", accountId, name: next, isAdmin }, previous);
    const { displayName } = await state.setDisplayName(next);
    return { isAdmin, displayName };
  }

  async listNotes(options?: { includeArchived?: boolean }): Promise<ProbeNoteView[]> {
    const notes = await this.#deps.store.listNotes({
      includeArchived: options?.includeArchived === true,
    });
    return notes.map(toNoteView);
  }

  async addNote(body: string): Promise<ProbeNoteView> {
    return toNoteView(await this.#deps.store.addNoteAsPerson(await this.#person(), body));
  }

  async archiveNote(noteId: string): Promise<ProbeNoteView> {
    return toNoteView(await this.#deps.store.archiveNoteAsPerson(await this.#person(), noteId));
  }

  async listAuditLog(options?: { limit?: number; before?: number }): Promise<AuditPage> {
    requireAdmin(this.#deps.isAdmin, "The audit log");
    return this.#deps.store.listAudit(options ?? {});
  }

  /** The person behind this mount. Every human edit is signed, so a name is required first. */
  async #person(): Promise<PersonActor> {
    const { displayName } = await this.#deps.state.getProfile();
    if (!displayName) throw new Error("Set your display name before making changes.");
    return {
      kind: "person",
      accountId: this.#deps.accountId,
      name: displayName,
      isAdmin: this.#deps.isAdmin,
    };
  }
}
