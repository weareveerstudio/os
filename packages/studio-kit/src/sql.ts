/**
 * Schema migrations for a Durable Object's SQLite storage.
 *
 * Wrangler migrations only create and rename classes; the tables inside them are ours. Each step
 * runs once, in order, inside one storage transaction together with the record of having run it, so
 * a failing step leaves nothing half-applied and is retried on the next activation.
 *
 * Steps are append-only: never edit or reorder a shipped step, add a new one.
 */

/** One schema change. `id` is a stable, unique label such as `"probe-0001-notes"`. */
export type MigrationStep = {
  id: string;
  /** SQL statements, run in order with `sql.exec`. */
  sql: readonly string[];
};

const LEDGER = "studio_schema_migrations";

/**
 * Applies every step not yet recorded, in order.
 * @param storage The Durable Object's storage (`ctx.storage`).
 * @param steps Every step the class has ever shipped, oldest first.
 * @returns The ids applied by this call.
 */
export function migrate(storage: DurableObjectStorage, steps: readonly MigrationStep[]): string[] {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate migration step id "${step.id}".`);
    ids.add(step.id);
  }
  return storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    const applied = new Set(
      storage.sql.exec<{ id: string }>(`SELECT id FROM ${LEDGER}`).toArray().map((row) => row.id));
    const ran: string[] = [];
    for (const step of steps) {
      if (applied.has(step.id)) continue;
      for (const statement of step.sql) storage.sql.exec(statement);
      storage.sql.exec(`INSERT INTO ${LEDGER} (id, applied_at) VALUES (?, ?)`, step.id, Date.now());
      ran.push(step.id);
    }
    return ran;
  });
}

/**
 * Lists the steps recorded as applied, oldest first. For tests and diagnostics.
 * @param storage The Durable Object's storage.
 * @returns Applied step ids.
 */
export function appliedMigrations(storage: DurableObjectStorage): string[] {
  const exists = storage.sql.exec<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", LEDGER).one().n;
  if (!exists) return [];
  return storage.sql.exec<{ id: string }>(`SELECT id FROM ${LEDGER} ORDER BY rowid`)
    .toArray().map((row) => row.id);
}
