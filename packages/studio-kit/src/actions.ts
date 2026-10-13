/**
 * Conventions for a gate's agent actions, on top of gatekeeper-kit's `defineActions`.
 *
 * Decision 6 of the canon: agents act freely, and every agent write is `autoApprovable` with
 * `delivery: "continue-with-simulation"`. The Workshop's approval queue stops at the first action
 * that needs a human and never skips ahead, so a single approval-only kind would stall every later
 * write from the same gate. {@link agentWrite} is how a gate declares a kind, so that rule cannot be
 * forgotten one kind at a time.
 *
 * The kit's journal lives in the facet's storage, which is per workspace. `applyAction` writes to
 * the studio-wide store, and the store makes the write idempotent on an {@link operationId} minted
 * when the action was submitted, claimed with {@link AppliedActions} in the same transaction as the
 * write.
 */

import type { ActionDefinition } from "@gadgets/gatekeeper-kit/actions";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { MigrationStep } from "./sql.js";

const SEGMENT = /^[a-z][a-z0-9-]*$/;

/**
 * An action kind with a namespaced tag. Auto-approval rules key on the tag, per workspace and per
 * gatekeeper, so it is a stable identifier: never rename a shipped one.
 * @param gate The gate's key, e.g. `"probe"`.
 * @param verb The operation, e.g. `"add-note"`.
 * @param label Shown in the auto-approval UI, e.g. `"Add a Probe note"`.
 * @returns `{tag: "<gate>.<verb>", label}`.
 */
export function actionKind(gate: string, verb: string, label: string): ActionKind {
  if (!SEGMENT.test(gate) || !SEGMENT.test(verb)) {
    throw new Error(`Action kind segments must be lowercase words: "${gate}", "${verb}".`);
  }
  if (!label.trim()) throw new Error("Action kind label can't be empty.");
  return { tag: `${gate}.${verb}`, label };
}

/** The two policy fields every agent write takes. */
export const AGENT_WRITE_POLICY = {
  autoApprovable: true,
  delivery: "continue-with-simulation",
} as const;

/**
 * Declares an agent write: auto-approvable, delivered with simulation, and tagged. The definition
 * cannot override either policy field.
 * @param definition The kind's `describe`, `apply` and other handlers, with a required `kind`.
 * @returns A definition for `defineActions`.
 */
export function agentWrite<Payload, Host>(
  definition: Omit<ActionDefinition<Payload, Host>, "autoApprovable" | "delivery"> & {
    kind: ActionKind;
  },
): ActionDefinition<Payload, Host> {
  const forbidden = definition as Partial<ActionDefinition<Payload, Host>>;
  if (forbidden.autoApprovable !== undefined || forbidden.delivery !== undefined) {
    throw new Error("agentWrite sets autoApprovable and delivery itself.");
  }
  return { ...definition, ...AGENT_WRITE_POLICY };
}

/**
 * Mints the idempotency key for one agent write. Mint it when the action is submitted, store it in
 * the action's payload, and claim it with {@link AppliedActions} when the action applies.
 *
 * Not the journal's action id, even qualified by the workspace: a workspace's capsule is re-created
 * with an empty journal whenever it is removed and added back (the gate disabled and re-enabled in
 * `/admin`, or an optional account removed and re-added), and the new journal numbers its actions
 * from 1 again under the same workspace id. A key built from those collides with one the store
 * already holds, and the approved write is silently skipped.
 * @returns A random UUID.
 */
export function operationId(): string {
  return crypto.randomUUID();
}

const TABLE = "studio_applied_actions";

/** The ledger's schema. Include these in the store's own migration list, once. */
export const APPLIED_ACTIONS_MIGRATIONS: readonly MigrationStep[] = [{
  id: "studio-kit-0002-applied-actions",
  sql: [`CREATE TABLE ${TABLE} (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`],
}];

/**
 * Records which agent actions a store has applied. Use it inside the store's `transactionSync`
 * together with the write itself:
 *
 * ```ts
 * this.ctx.storage.transactionSync(() => {
 *   if (!this.#applied.claim(key)) return;   // a replay: already written
 *   insertTheRow();
 * });
 * ```
 */
export class AppliedActions {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  /**
   * @param sql The store's `ctx.storage.sql`, migrated with {@link APPLIED_ACTIONS_MIGRATIONS}.
   * @param options `now` for tests.
   */
  constructor(sql: SqlStorage, options: { now?: () => number } = {}) {
    this.#sql = sql;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records `key` as applied.
   * @param key An {@link operationId} from the action's payload.
   * @returns True the first time, false on every replay.
   */
  claim(key: string): boolean {
    return this.#sql.exec(
      `INSERT INTO ${TABLE} (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
      key, this.#now()).rowsWritten > 0;
  }

  /**
   * @param key An {@link operationId} from the action's payload.
   * @returns Whether `key` was applied.
   */
  has(key: string): boolean {
    return this.#sql.exec(`SELECT 1 FROM ${TABLE} WHERE key = ?`, key).toArray().length > 0;
  }
}
