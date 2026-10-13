/**
 * The studio-wide notes store: one fixed-name Durable Object (`sharedStore()`), reached only from
 * this Worker through `ctx.exports.ProbeNotesStore`. Every write records its audit row in the same
 * transaction.
 */

import { DurableObject } from "cloudflare:workers";
import { APPLIED_ACTIONS_MIGRATIONS, AppliedActions } from "@veer/studio-kit/actions";
import {
  AUDIT_LOG_MIGRATIONS,
  AuditLog,
  type AuditActor,
  type AuditPage,
} from "@veer/studio-kit/audit-log";
import { requireId, requireText } from "@veer/studio-kit/guards";
import { migrate, type MigrationStep } from "@veer/studio-kit/sql";
import { MAX_NOTE_LENGTH } from "./ui-types.js";

/** Who wrote a note, as stored. */
export type NoteAuthor =
  | { kind: "person"; accountId: string; name: string }
  | { kind: "agent"; accountId: string; workspaceId: string };

/** A note as stored. */
export type StoredNote = {
  id: string;
  body: string;
  createdAt: number;
  author: NoteAuthor;
  archivedAt: number | null;
  archivedBy: string | null;
};

/** A person making a change in the app, already holding a display name. */
export type PersonActor = Extract<AuditActor, { kind: "person" }>;

/** An approved agent note, as `applyAction` hands it over. */
export type AgentNote = {
  /** `appliedActionKey(workspaceId, actionId)`. */
  key: string;
  noteId: string;
  body: string;
  accountId: string;
  workspaceId: string;
};

/** The most notes one listing returns. */
export const MAX_LISTED_NOTES = 500;

/**
 * Checks a note body: trimmed, 1 to {@link MAX_NOTE_LENGTH} characters, line breaks allowed. The
 * agent path checks it at submit time and the store again at write time, with this same function,
 * so an approved action cannot fail it.
 * @param body Candidate body.
 * @returns The trimmed body.
 */
export function requireNoteBody(body: unknown): string {
  return requireText(body, { label: "Note", max: MAX_NOTE_LENGTH, multiline: true });
}

const MIGRATIONS: readonly MigrationStep[] = [
  ...AUDIT_LOG_MIGRATIONS,
  ...APPLIED_ACTIONS_MIGRATIONS,
  {
    id: "probe-0001-notes",
    sql: [
      `CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
        author_account TEXT NOT NULL,
        author_name TEXT,
        author_workspace TEXT,
        archived_at INTEGER,
        archived_by TEXT
      )`,
      "CREATE INDEX notes_by_created ON notes (created_at DESC)",
    ],
  },
];

type NoteRow = {
  id: string;
  body: string;
  created_at: number;
  author_kind: "person" | "agent";
  author_account: string;
  author_name: string | null;
  author_workspace: string | null;
  archived_at: number | null;
  archived_by: string | null;
};

function toNote(row: NoteRow): StoredNote {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: row.author_kind === "person"
      ? { kind: "person", accountId: row.author_account, name: row.author_name ?? "" }
      : { kind: "agent", accountId: row.author_account, workspaceId: row.author_workspace ?? "" },
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
  };
}

// Methods that can throw are async: a synchronous throw from a Durable Object RPC method is also
// reported to the runtime as an uncaught exception, on top of rejecting the caller's promise.
export class ProbeNotesStore extends DurableObject {
  readonly #audit: AuditLog;
  readonly #applied: AppliedActions;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    migrate(ctx.storage, MIGRATIONS);
    this.#audit = new AuditLog(ctx.storage.sql);
    this.#applied = new AppliedActions(ctx.storage.sql);
  }

  /**
   * Lists notes, newest first.
   * @param options `includeArchived` also returns archived notes.
   * @returns At most {@link MAX_LISTED_NOTES} notes.
   */
  listNotes(options: { includeArchived?: boolean } = {}): StoredNote[] {
    const archived = options.includeArchived === true ? "" : "WHERE archived_at IS NULL";
    return this.ctx.storage.sql.exec<NoteRow>(
      `SELECT * FROM notes ${archived} ORDER BY created_at DESC, id LIMIT ?`, MAX_LISTED_NOTES,
    ).toArray().map(toNote);
  }

  /**
   * @param id A note id.
   * @returns The note, or null.
   */
  getNote(id: string): StoredNote | null {
    const row = this.ctx.storage.sql.exec<NoteRow>("SELECT * FROM notes WHERE id = ?", id)
      .toArray()[0];
    return row ? toNote(row) : null;
  }

  /**
   * Adds a note written in the app.
   * @param actor The person, with their display name.
   * @param body The note.
   * @returns The stored note.
   */
  async addNoteAsPerson(actor: PersonActor, body: string): Promise<StoredNote> {
    const text = requireNoteBody(body);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO notes (id, body, created_at, author_kind, author_account, author_name)
          VALUES (?, ?, ?, 'person', ?, ?)`,
        id, text, now, actor.accountId, actor.name);
      this.#audit.append({ actor, action: "note.add", target: id, detail: { body: text } });
    });
    return this.getNote(id)!;
  }

  /**
   * Archives a note from the app. Archiving an archived note changes nothing and records nothing.
   * @param actor The person, with their display name.
   * @param id The note.
   * @returns The note as it now is.
   */
  async archiveNoteAsPerson(actor: PersonActor, id: string): Promise<StoredNote> {
    requireId(id, "Note");
    this.ctx.storage.transactionSync(() => {
      const note = this.getNote(id);
      if (!note) throw new Error("That note no longer exists.");
      if (note.archivedAt !== null) return;
      this.ctx.storage.sql.exec(
        "UPDATE notes SET archived_at = ?, archived_by = ? WHERE id = ?", Date.now(), actor.name, id);
      this.#audit.append({ actor, action: "note.archive", target: id });
    });
    return this.getNote(id)!;
  }

  /**
   * Writes an approved agent note, once. A replay of the same action, from a lost reply or a retry,
   * changes nothing.
   * @param note The action's payload and its idempotency key.
   */
  async applyAgentNote(note: AgentNote): Promise<void> {
    const text = requireNoteBody(note.body);
    requireId(note.noteId, "Note");
    this.ctx.storage.transactionSync(() => {
      if (!this.#applied.claim(note.key)) return;
      const inserted = this.ctx.storage.sql.exec(
        `INSERT INTO notes (id, body, created_at, author_kind, author_account, author_workspace)
          VALUES (?, ?, ?, 'agent', ?, ?) ON CONFLICT (id) DO NOTHING`,
        note.noteId, text, Date.now(), note.accountId, note.workspaceId).rowsWritten;
      if (!inserted) return;
      this.#audit.append({
        actor: { kind: "agent", accountId: note.accountId, workspaceId: note.workspaceId },
        action: "note.add",
        target: note.noteId,
        detail: { body: text },
      });
    });
  }

  /**
   * Records a display-name change. The name itself lives in the account's own state.
   * @param actor The person, under their new name.
   * @param previous Their name before, if any.
   */
  async recordNameChange(actor: PersonActor, previous: string | null): Promise<void> {
    this.#audit.append({
      actor, action: "profile.set-name", target: actor.accountId, detail: { previous },
    });
  }

  /**
   * Reads the audit log, newest first.
   * @param options Page size and cursor.
   * @returns One page.
   */
  async listAudit(options: { limit?: number; before?: number } = {}): Promise<AuditPage> {
    return this.#audit.list(options);
  }
}
