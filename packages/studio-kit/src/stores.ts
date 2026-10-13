/**
 * Names for the studio-wide stores a gate owns.
 *
 * Studio data (notes, clients, invoices, projects) lives in Durable Objects with fixed names rather
 * than in per-account or per-workspace storage, so every partner, every contractor and every agent
 * workspace reads the same records. This is the Context Gatekeeper's pattern:
 * `ctx.exports.Store.getByName(name)`. Accounts hold only per-account state (see
 * `account-state.ts`), and `revoke()` never touches a store.
 *
 * A store class belongs to one gate's Worker, so the name only has to be unique within that class.
 * One name is enough until a store needs sharding; `storeName()` covers that case without a second
 * convention.
 */

/** The one instance name every gate uses for its studio-wide store. */
export const SHARED_STORE_NAME = "veer-studio";

/**
 * The instance name for one partition of a studio-wide store, for a gate that outgrows a single
 * instance. Partitions are stable identities: renaming one strands its data.
 * @param partition A stable, lowercase partition key such as `"2027"`.
 * @returns `veer-studio:<partition>`.
 */
export function storeName(partition: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(partition)) {
    throw new Error(`Store partition "${partition}" must be lowercase letters, digits and hyphens.`);
  }
  return `${SHARED_STORE_NAME}:${partition}`;
}

/**
 * The studio-wide instance of a store class.
 * @param namespace The class's namespace, `ctx.exports.<Store>` inside the gate's Worker.
 * @returns A stub for the fixed-name instance.
 */
export function sharedStore<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
): DurableObjectStub<T> {
  return namespace.getByName(SHARED_STORE_NAME);
}
