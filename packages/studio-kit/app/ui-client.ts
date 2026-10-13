/**
 * Types for a gate's flat `ui` capability, shared by the Worker that implements it and the app that
 * calls it.
 *
 * The Workshop wraps `ui` in a rate limiter (8 concurrent calls, 600 a minute) that forwards
 * top-level method names only: `ui.listNotes()` works, `ui.notes.list()` does not, and a property
 * read yields a function rather than a value. A gate therefore describes its `ui` as one interface of
 * methods and checks it with {@link FlatUi}.
 */

/**
 * Resolves to `T` when every member is a method, and flags the offending members otherwise. Use it
 * where the Worker's implementation meets the interface:
 * `class ProbeAppApi extends RpcTarget implements FlatUi<ProbeUi>`.
 */
export type FlatUi<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? T[K] : never;
};

/** How the app sees a `ui` method across the RPC boundary: always asynchronous. */
export type UiClient<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * The message to show for a failed `ui` call. Errors cross the RPC boundary as copies whose message
 * may carry an `Error:` prefix; the gate's own messages are written to be shown as they are.
 * @param error What the call rejected with.
 * @returns A one-line message.
 */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.replace(/^(?:[A-Za-z]*Error:\s*)+/, "").trim();
  return message || "Something went wrong. Try again.";
}
