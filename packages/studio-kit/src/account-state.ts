/**
 * Per-account state: the self-declared display name and the admin mark.
 *
 * A gate never learns which human is acting. Its account is a stateless `WorkerEntrypoint` whose
 * props carry only an `accountId`, and the only authority signal the Workshop gives is
 * `AppUiContext.isAdmin`, fresh on every app mount. This Durable Object, one per account
 * (`getByName(accountId)`), holds what the gate remembers about the person behind an account:
 *
 * - **Display name.** Set by the person in the gate's app and shown as the author of their edits.
 *   Self-declared, like the Docs blueprint's collaborator identity: it labels, it does not
 *   authenticate.
 * - **Admin mark.** Recorded by `startAppUi` on every mount: set when `isAdmin`, cleared when not.
 *   The agent path has no `isAdmin`, so a restricted gate (Finance) checks this mark on every session
 *   call. An admin therefore has to open the app once before their agents can use the gate, and a
 *   demoted admin loses agent access at their next app mount.
 *
 * `revoke()` deletes this state only. Studio data lives in the gate's shared store and stays.
 *
 * Gates re-export this class from their Worker's main module and list it in their wrangler
 * migrations, then reach it as `ctx.exports.StudioAccountState.getByName(accountId)`.
 */

import { DurableObject } from "cloudflare:workers";
import { JOINERS } from "./guards.js";

/** What a person has said about themselves. */
export type AccountProfile = { displayName: string | null };

/** The last admin status `startAppUi` saw, and when. */
export type AdminMark = { isAdmin: boolean; at: number };

export const MAX_DISPLAY_NAME_LENGTH = 60;

const PROFILE_KEY = "profile";
const ADMIN_MARK_KEY = "admin-mark";

/**
 * Trims a display name and checks it is printable, non-empty and short.
 * @param name Candidate name.
 * @returns The normalized name.
 */
export function normalizeDisplayName(name: unknown): string {
  if (typeof name !== "string") throw new Error("Display name must be text.");
  if (!name.isWellFormed()) throw new Error("Display name contains invalid characters.");
  const trimmed = name.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("Display name can't be empty.");
  if ([...trimmed].length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }
  // Format and control characters can make two different names render identically. The joiners
  // are exempt, as in requireText: Persian names need the non-joiner.
  if (/[\p{Cc}\p{Cf}]/u.test(trimmed.replace(JOINERS, ""))) {
    throw new Error("Display name can't contain control or formatting characters.");
  }
  return trimmed;
}

// Methods that can throw are async: a synchronous throw from a Durable Object RPC method is also
// reported to the runtime as an uncaught exception, on top of rejecting the caller's promise.
export class StudioAccountState extends DurableObject {
  /** @returns The account's profile. */
  getProfile(): AccountProfile {
    return { displayName: this.ctx.storage.kv.get<string>(PROFILE_KEY) ?? null };
  }

  /**
   * Sets the display name.
   * @param name The new name; normalized with {@link normalizeDisplayName}.
   * @returns The updated profile.
   */
  async setDisplayName(name: string): Promise<AccountProfile> {
    const displayName = normalizeDisplayName(name);
    this.ctx.storage.kv.put(PROFILE_KEY, displayName);
    return { displayName };
  }

  /**
   * Records the admin status `startAppUi` received.
   * @param isAdmin `AppUiContext.isAdmin` from this mount.
   * @param at Time of the mount, for tests.
   */
  async markAdmin(isAdmin: boolean, at: number = Date.now()): Promise<void> {
    if (typeof isAdmin !== "boolean") throw new TypeError("isAdmin must be a boolean.");
    this.ctx.storage.kv.put<AdminMark>(ADMIN_MARK_KEY, { isAdmin, at });
  }

  /** @returns The last recorded mark, or null if the app was never opened. */
  getAdminMark(): AdminMark | null {
    return this.ctx.storage.kv.get<AdminMark>(ADMIN_MARK_KEY) ?? null;
  }

  /** @returns Whether the last app mount was an admin's. False if the app was never opened. */
  isMarkedAdmin(): boolean {
    return this.getAdminMark()?.isAdmin === true;
  }

  /** Deletes this account's state. Studio data is untouched. */
  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * Throws unless the account's last app mount was an admin's. For the agent path of a restricted
 * gate, where no `isAdmin` is available.
 * @param state The account's state stub.
 * @param gateName Shown in the error, e.g. "Finance".
 */
export async function requireAdminMark(
  state: { isMarkedAdmin(): boolean | Promise<boolean> },
  gateName: string,
): Promise<void> {
  if (await state.isMarkedAdmin() !== true) {
    throw new Error(
      `${gateName} is for admins only. An admin has to open the ${gateName} app once before ` +
      "agents can use it.");
  }
}
