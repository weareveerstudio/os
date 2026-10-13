/**
 * The audit log's data types, with no runtime and no Workers types, so a gate's app can import
 * them as well as its Worker. The log itself is `./audit-log`.
 */

/**
 * What a change carried, as a flat record of primitives: `{ body: "..." }`, `{ previous: null }`.
 * Flat rather than arbitrary JSON so the type crosses Workers RPC typing without recursion.
 */
export type AuditDetail = { [key: string]: string | number | boolean | null } | null;

/** Who made a change. People are named by the display name they set on their own account. */
export type AuditActor =
  | { kind: "person"; accountId: string; name: string; isAdmin: boolean }
  | { kind: "agent"; accountId: string; workspaceId: string };

/** One recorded change. */
export type AuditEntry = {
  /** Monotonic position in the log; never reused. */
  seq: number;
  /** Milliseconds since the epoch. */
  at: number;
  actor: AuditActor;
  /** Dotted verb such as `note.add`. */
  action: string;
  /** The id of the record changed, when there is one. */
  target: string | null;
  /** What changed, as JSON; null when the action and target say it all. */
  detail: AuditDetail;
};

/** One page of the log, newest first. */
export type AuditPage = {
  entries: AuditEntry[];
  /** Pass as `before` to read the next (older) page; absent on the last page. */
  nextBefore?: number;
};
