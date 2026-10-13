/**
 * Test helpers for a gate's workerd suite (`@cloudflare/vitest-pool-workers`).
 *
 * - {@link FakeApprovalQueue} stands in for the Overseer's approval queue and records what a
 *   session authorized and submitted.
 * - {@link StudioFacetHost} hosts a gate's Gatekeeper class as a facet of a parent Durable Object,
 *   the way the Overseer does, so the facet's `ctx.id` is the parent's id: the workspace id.
 *
 * A gate's test worker re-exports `StudioFacetHost` and declares it in its vitest miniflare config
 * (`durableObjects: { FACET_HOST: { className: "StudioFacetHost", useSQLite: true } }`).
 */

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  AgentCatalog,
  GatekeeperUserVerifier,
  ObservationDescription,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";

/**
 * Records observations and submitted actions. Pass an instance to a session-starting call; the
 * gate receives a real RPC stub for it, with `dup()`, as it would from the Overseer.
 */
export class FakeApprovalQueue extends RpcTarget {
  readonly observations: ObservationDescription[] = [];
  readonly submissions: { action: number; description: ActionDescription }[] = [];
  #refuseNext = false;

  /** Makes the next observation fail, as an Overseer policy refusal does. */
  refuseNextObservation(): void {
    this.#refuseNext = true;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.#refuseNext) {
      this.#refuseNext = false;
      throw new Error("The overseer refused this observation.");
    }
    this.observations.push(structuredClone(description));
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.submissions.push({ action, description: structuredClone(description) });
  }

  async bindHook(): Promise<void> {
    throw new Error("FakeApprovalQueue does not support hooks.");
  }

  async getGitCache(): Promise<never> {
    throw new Error("FakeApprovalQueue has no git cache.");
  }
}

/** Which Gatekeeper class to host, and the props its account would imbue it with. */
export type FacetSpec = {
  /** The export name of the gate's Gatekeeper class, e.g. `"ProbeGatekeeper"`. */
  className: string;
  /** The props `getSingletonGatekeeperClass()` would pass, e.g. `{accountId}`. */
  props: Record<string, unknown>;
  /** The facet's name under the parent. The Overseer uses `gatekeeper<n>`. */
  name?: string;
};

/**
 * The git cache the Overseer hands `applyAction`. Studio gates never touch git, but the argument is
 * part of the `Gatekeeper` contract that `@validateRpc()` checks.
 */
class NoGitCache extends RpcTarget {
  async advertiseCommit(): Promise<never> {
    throw new Error("Studio gates have no git cache.");
  }
}

type HostedGatekeeper = {
  describe(): Promise<ResourceDescription>;
  getTypeScriptTypes(): Promise<string>;
  getAutoApprovableActions(): Promise<ActionKind[]>;
  startSession(queue: unknown): Promise<unknown>;
  getAgentCatalog?(): Promise<AgentCatalog | null>;
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  removeObserver(id: string): Promise<void>;
  applyAction(action: number, cache: NoGitCache): Promise<void>;
  rejectAction(action: number): Promise<void | { restart?: boolean }>;
  revertAction(action: number): Promise<unknown>;
};

/**
 * A stand-in Overseer: one instance per workspace (`idFromName(...)`), hosting Gatekeeper facets.
 * Every method forwards to the named facet.
 */
export class StudioFacetHost extends DurableObject {
  #facet(spec: FacetSpec): HostedGatekeeper {
    const exports = this.ctx.exports as unknown as Record<
      string, (options: { props: Record<string, unknown> }) => DurableObjectClass>;
    const factory = exports[spec.className];
    if (typeof factory !== "function") {
      throw new Error(`The test worker does not export ${spec.className}.`);
    }
    return this.ctx.facets.get(spec.name ?? "gatekeeper1", () => ({
      class: factory({ props: spec.props }),
    })) as unknown as HostedGatekeeper;
  }

  /** @returns This instance's id: the workspace id its facets inherit. */
  workspaceId(): string {
    return this.ctx.id.toString();
  }

  describe(spec: FacetSpec) {
    return this.#facet(spec).describe();
  }

  getTypeScriptTypes(spec: FacetSpec) {
    return this.#facet(spec).getTypeScriptTypes();
  }

  getAutoApprovableActions(spec: FacetSpec) {
    return this.#facet(spec).getAutoApprovableActions();
  }

  startSession(spec: FacetSpec, queue: FakeApprovalQueue) {
    return this.#facet(spec).startSession(queue);
  }

  async getAgentCatalog(spec: FacetSpec) {
    return (await this.#facet(spec).getAgentCatalog?.()) ?? null;
  }

  addObserver(spec: FacetSpec, id: string, user: Fetcher<GatekeeperUserVerifier>) {
    return this.#facet(spec).addObserver(id, user);
  }

  removeObserver(spec: FacetSpec, id: string) {
    return this.#facet(spec).removeObserver(id);
  }

  applyAction(spec: FacetSpec, action: number) {
    return this.#facet(spec).applyAction(action, new NoGitCache());
  }

  rejectAction(spec: FacetSpec, action: number) {
    return this.#facet(spec).rejectAction(action);
  }

  revertAction(spec: FacetSpec, action: number) {
    return this.#facet(spec).revertAction(action);
  }
}

/**
 * Awaits a call expected to fail and returns its message. Use it rather than
 * `expect(stub.method()).rejects`: Vitest's `rejects` leaves a branch of an RPC promise unhandled,
 * which the pool then reports as an error of the whole run.
 * @param call Makes the call, usually on a Durable Object or RPC stub.
 * @returns The rejection's message.
 */
export async function rejectionMessage(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the call to fail, but it succeeded.");
}
