/**
 * The append-only audit log a gate keeps beside its studio data.
 *
 * Nothing in the sidebar-app path is audited or approved by the Workshop, so every human edit made
 * in a gate's app is recorded here, in the same storage transaction as the edit. Agent writes reach
 * the store through `applyAction` after the Workshop's own approval record; gates log those too, so
 * one table holds the store's complete change history.
 *
 * Append-only is enforced by SQLite triggers, not by convention: an UPDATE or DELETE on the table
 * aborts. Only `deleteAll()` on the whole Durable Object can remove rows.
 */

import type { AuditActor, AuditDetail, AuditEntry, AuditPage } from "./audit-types.js";
import type { MigrationStep } from "./sql.js";

export type { AuditActor, AuditDetail, AuditEntry, AuditPage } from "./audit-types.js";

export const MAX_AUDIT_DETAIL_BYTES = 16 * 1024;
export const MAX_AUDIT_PAGE = 200;
const ACTION_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

const TABLE = "studio_audit_log";

/** The log's schema. Include these in the store's own migration list, once. */
export const AUDIT_LOG_MIGRATIONS: readonly MigrationStep[] = [{
  id: "studio-kit-0001-audit-log",
  sql: [
    `CREATE TABLE ${TABLE} (
      seq INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent')),
      actor_account TEXT NOT NULL,
      actor_name TEXT,
      actor_admin INTEGER,
      actor_workspace TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT
    )`,
    `CREATE TRIGGER ${TABLE}_no_update BEFORE UPDATE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT, '${TABLE} is append-only'); END`,
    `CREATE TRIGGER ${TABLE}_no_delete BEFORE DELETE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT, '${TABLE} is append-only'); END`,
  ],
}];

type Row = {
  seq: number;
  at: number;
  actor_kind: "person" | "agent";
  actor_account: string;
  actor_name: string | null;
  actor_admin: number | null;
  actor_workspace: string | null;
  action: string;
  target: string | null;
  detail: string | null;
};

/** Reads and appends audit rows. Construct it inside the Durable Object that owns the storage. */
export class AuditLog {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  /**
   * @param sql The store's `ctx.storage.sql`, already migrated with {@link AUDIT_LOG_MIGRATIONS}.
   * @param options `now` for tests.
   */
  constructor(sql: SqlStorage, options: { now?: () => number } = {}) {
    this.#sql = sql;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Appends one row. Call it in the same synchronous block (or `transactionSync`) as the change it
   * records, so the change and its record commit together.
   * @param input The actor, a dotted action, and optional target and detail.
   * @returns The stored entry.
   */
  append(input: { actor: AuditActor; action: string; target?: string | null; detail?: AuditDetail }):
      AuditEntry {
    if (!ACTION_PATTERN.test(input.action)) {
      throw new Error(`Audit action "${input.action}" must be a dotted lowercase verb like note.add.`);
    }
    const detail = input.detail === undefined ? null : JSON.stringify(input.detail);
    if (detail !== null && new TextEncoder().encode(detail).byteLength > MAX_AUDIT_DETAIL_BYTES) {
      throw new Error(`Audit detail exceeds ${MAX_AUDIT_DETAIL_BYTES} bytes.`);
    }
    const { actor } = input;
    const at = this.#now();
    const target = input.target ?? null;
    const seq = this.#sql.exec<{ seq: number }>(
      `INSERT INTO ${TABLE}
        (at, actor_kind, actor_account, actor_name, actor_admin, actor_workspace, action, target, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      at,
      actor.kind,
      actor.accountId,
      actor.kind === "person" ? actor.name : null,
      actor.kind === "person" ? (actor.isAdmin ? 1 : 0) : null,
      actor.kind === "agent" ? actor.workspaceId : null,
      input.action,
      target,
      detail,
    ).one().seq;
    return { seq, at, actor: structuredClone(actor), action: input.action, target,
      detail: detail === null ? null : JSON.parse(detail) as AuditDetail };
  }

  /**
   * Reads one page, newest first.
   * @param options `limit` (1 to {@link MAX_AUDIT_PAGE}, default 50) and `before`, a `seq` from a
   * previous page's `nextBefore`.
   * @returns The page.
   */
  list(options: { limit?: number; before?: number } = {}): AuditPage {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE) {
      throw new Error(`Audit page size must be between 1 and ${MAX_AUDIT_PAGE}.`);
    }
    const before = options.before;
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
      throw new Error("Audit cursor must be a positive integer.");
    }
    // One row past the page tells whether an older page exists.
    const rows = (before === undefined
      ? this.#sql.exec<Row>(`SELECT * FROM ${TABLE} ORDER BY seq DESC LIMIT ?`, limit + 1)
      : this.#sql.exec<Row>(
        `SELECT * FROM ${TABLE} WHERE seq < ? ORDER BY seq DESC LIMIT ?`, before, limit + 1)
    ).toArray();
    const entries = rows.slice(0, limit).map(toEntry);
    return rows.length > limit ? { entries, nextBefore: entries.at(-1)!.seq } : { entries };
  }
}

function toEntry(row: Row): AuditEntry {
  const actor: AuditActor = row.actor_kind === "person"
    ? { kind: "person", accountId: row.actor_account, name: row.actor_name ?? "",
      isAdmin: row.actor_admin === 1 }
    : { kind: "agent", accountId: row.actor_account, workspaceId: row.actor_workspace ?? "" };
  return {
    seq: row.seq,
    at: row.at,
    actor,
    action: row.action,
    target: row.target,
    detail: row.detail === null ? null : JSON.parse(row.detail) as AuditDetail,
  };
}
