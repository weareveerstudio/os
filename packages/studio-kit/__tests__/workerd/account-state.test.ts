import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
  requireAdminMark,
} from "../../src/account-state.js";
import { rejectionMessage } from "../../src/testing.js";

describe("StudioAccountState", () => {
  it("starts with no display name and no admin mark", async () => {
    const state = env.ACCOUNT_STATE.getByName("fresh");
    expect(await state.getProfile()).toEqual({ displayName: null });
    expect(await state.getAdminMark()).toBeNull();
    expect(await state.isMarkedAdmin()).toBe(false);
  });

  it("stores a normalized display name", async () => {
    const state = env.ACCOUNT_STATE.getByName("named");
    expect(await state.setDisplayName("  Ada \n Lovelace ")).toEqual({ displayName: "Ada Lovelace" });
    expect(await state.getProfile()).toEqual({ displayName: "Ada Lovelace" });
  });

  it("refuses empty, long and invisible-character names", async () => {
    const state = env.ACCOUNT_STATE.getByName("refusals");
    expect(await rejectionMessage(() => state.setDisplayName("   "))).toMatch(/can't be empty/);
    expect(await rejectionMessage(
      () => state.setDisplayName("x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)))).toMatch(/at most/);
    expect(await rejectionMessage(() => state.setDisplayName("Ada\u202eLovelace")))
      .toMatch(/control or formatting/);
    expect(await state.getProfile()).toEqual({ displayName: null });
  });

  it("sets and clears the admin mark on each app mount", async () => {
    const state = env.ACCOUNT_STATE.getByName("admin");
    await state.markAdmin(true, 1_000);
    expect(await state.getAdminMark()).toEqual({ isAdmin: true, at: 1_000 });
    expect(await state.isMarkedAdmin()).toBe(true);
    await expect(requireAdminMark(state, "Finance")).resolves.toBeUndefined();

    await state.markAdmin(false, 2_000);
    expect(await state.getAdminMark()).toEqual({ isAdmin: false, at: 2_000 });
    expect(await rejectionMessage(() => requireAdminMark(state, "Finance")))
      .toMatch(/Finance is for admins only/);
  });

  it("refuses the agent path until an admin has opened the app", async () => {
    expect(await rejectionMessage(
      () => requireAdminMark(env.ACCOUNT_STATE.getByName("never-opened"), "Finance")))
      .toMatch(/has to open the Finance app once/);
  });

  it("revoke() clears the account's state", async () => {
    const state = env.ACCOUNT_STATE.getByName("revoked");
    await state.setDisplayName("Grace");
    await state.markAdmin(true);
    await state.revoke();
    expect(await state.getProfile()).toEqual({ displayName: null });
    expect(await state.getAdminMark()).toBeNull();
  });

  it("normalizes in isolation too", () => {
    expect(normalizeDisplayName("Zoë")).toBe("Zoë");
    expect(normalizeDisplayName("شهر\u200cیار")).toBe("شهر\u200cیار");
    expect(() => normalizeDisplayName("a\udc00")).toThrow(/invalid characters/);
    expect(() => normalizeDisplayName(42)).toThrow(/must be text/);
  });
});
