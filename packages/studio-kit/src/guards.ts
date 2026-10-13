/**
 * Input and permission checks for a gate's app `ui` and agent session.
 *
 * Both surfaces take arguments from code the gate does not control: the sandboxed app, and the
 * agent. `@validateRpc()` checks types at the RPC boundary; these check content. Their messages are
 * shown to the person or the agent as they are, so they name the problem and never echo the value.
 */

/**
 * Throws unless the caller is an admin. The app surface's `isAdmin` comes from the `AppUiContext`
 * of the mount that created the `ui` capability.
 * @param isAdmin The mount's admin status.
 * @param what What is being refused, as a sentence subject: `"The audit log"`.
 */
export function requireAdmin(isAdmin: boolean, what: string): void {
  if (isAdmin !== true) throw new Error(`${what} is available to admins only.`);
}

/**
 * Trims free text and checks its length and characters.
 * @param value The candidate value.
 * @param options `label` names the field in errors; `max` is in characters; `multiline` allows
 * line breaks and tabs.
 * @returns The trimmed text.
 */
export function requireText(
  value: unknown,
  options: { label: string; max: number; multiline?: boolean },
): string {
  const { label, max, multiline = false } = options;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error(`${label} can't be empty.`);
  if ([...text].length > max) throw new Error(`${label} must be at most ${max} characters.`);
  // Format characters (bidi overrides, zero-width joiners) can make text read differently from
  // what it is; control characters other than the allowed line breaks have no business here.
  const checked = multiline ? text.replace(/[\n\t]/g, "") : text;
  if (/[\p{Cc}\p{Cf}]/u.test(checked)) {
    throw new Error(`${label} can't contain control or formatting characters.`);
  }
  return text;
}

/**
 * Checks an opaque record id the gate minted (`crypto.randomUUID()`).
 * @param value The candidate id.
 * @param label Names the id in errors.
 * @returns The id.
 */
export function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${label} is not a valid id.`);
  }
  return value;
}
