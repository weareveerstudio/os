/**
 * The convention for showing an agent its own pending writes.
 *
 * Every agent write is `continue-with-simulation` (`agentWrite`), so the agent keeps working before
 * a person approves. Its later reads must therefore show the world as if its queued writes had
 * applied: each session read folds the facet's pending actions (`journal.listPending()`, this
 * workspace's only) over what the store returned. Other workspaces and the app see the change
 * once it applies.
 *
 * The step function returns the next state rather than mutating, and says `known-no-effect` for an
 * action whose effect the store already shows (it applied while the journal still listed it), so a
 * write is never shown twice.
 */

import {
  createSimulationView,
  replaySimulation,
  type SimulationStep,
} from "@gadgets/gatekeeper-kit/simulation";

export type { SimulationStep } from "@gadgets/gatekeeper-kit/simulation";

/**
 * Folds pending actions over a read, in action order.
 * @param base What the store returned.
 * @param pending The facet journal's pending entries.
 * @param step Projects one entry onto the state.
 * @returns The simulated state. If a step cannot project an entry (a kind this deploy dropped,
 * which fails at apply and stops projecting), the state up to it: honest rather than complete.
 */
export function foldPending<State, Entry extends { readonly id: number; readonly action: unknown }>(
  base: State,
  pending: readonly Entry[],
  step: (state: State, entry: Entry) => SimulationStep<State>,
): State {
  const view = createSimulationView(pending, () => [] as const);
  const result = replaySimulation<State, Entry>(base, view.all(), step);
  return result.kind === "complete" ? result.value : result.partial;
}
