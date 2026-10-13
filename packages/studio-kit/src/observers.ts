/**
 * Conventions for a gate's agent reads, on top of gatekeeper-kit's observers.
 *
 * Every session method that returns data authorizes it as an observation before returning:
 * fetch, authorize, return. Descriptions follow the same rule as action descriptions: prose is the
 * gate's own words, and any value that came from the store or the agent goes in a typed field.
 *
 * Strategy by gate (canon, "Observers"):
 * - Clients, Projects and the probe: `openObservers()` with `{kind: "baseline"}` reads. Studio data
 *   has no access distinction between the people who can open a studio workspace.
 * - Finance: `trackedCollectionObservers` with one synthetic collection, plus
 *   `containsRestrictedData` on every read (`observation(..., {restricted: true})`).
 *
 * Never use the `withholdFromObservers` scope: a refused read latches the binding unshareable.
 */

import {
  buildDescription,
  type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ObservationInput, ObservationScope } from "@gadgets/gatekeeper-kit/observers";

export {
  ObservationGate,
  openObservers,
  trackedCollectionObservers,
  escapeObservationValue,
  type ObservationInput,
  type ObservationScope,
} from "@gadgets/gatekeeper-kit/observers";

/** The scope of every read under `openObservers()`. */
export const BASELINE: ObservationScope = Object.freeze({ kind: "baseline" });

/**
 * Builds an observation description.
 * @param title One line, the gate's own words: `"List Probe notes"`. Never agent or store text.
 * @param intro The gate's own prose summary.
 * @param fields Adds the values read, as typed fields: `b => b.inline("Note ID", id)`.
 * @param options `restricted` marks the read `containsRestrictedData` (Finance).
 * @returns The input for `ObservationGate.authorize`.
 */
export function observation(
  title: string,
  intro: string,
  fields?: (builder: ActionDescriptionBuilder) => void,
  options: { restricted?: boolean } = {},
): ObservationInput {
  const builder = buildDescription(intro);
  fields?.(builder);
  // Completeness is an action-description claim; observations have no such field.
  const { descriptionIsComplete: _complete, ...rendered } = builder.finish();
  return {
    title,
    ...rendered,
    ...(options.restricted ? { containsRestrictedData: true } : {}),
  };
}
