import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { rejectionMessage } from "@veer/studio-kit/testing";
import { SHARED_STORE_NAME } from "@veer/studio-kit/stores";
import { describe, expect, it } from "vitest";
import { describeProbeAccount } from "../src/probe.js";
import type { ProbeUi } from "../src/ui-types.js";
import TYPES_CODE from "../src/types.txt";

type Frame = { iframeHtml: string; ui: ProbeUi };
type Account = {
  describe(): Promise<unknown>;
  startAppUi(context: { isAdmin: boolean }): Promise<Frame>;
  getSingletonGatekeeperClass(): Promise<unknown>;
  getSupportedResources(): Promise<unknown[]>;
  getAuthenticatedEmail(): Promise<string | null>;
  getVerifier(): Promise<{ verify(): Promise<void> }>;
  revoke(): Promise<void>;
};
type Vendor = {
  describe(): Promise<Record<string, unknown>>;
  createAccount(): Promise<Account>;
  getTypeScriptTypes(): Promise<string>;
};

const worker = createExecutionContext().exports as unknown as {
  GatekeeperVendor(options?: object): Vendor;
  ProbeAccount(options: { props: { accountId: string } }): Account;
};

function account(accountId: string): Account {
  return worker.ProbeAccount({ props: { accountId } });
}

function store() {
  return env.NOTES_STORE.getByName(SHARED_STORE_NAME);
}

describe("GatekeeperVendor", () => {
  it("is auto-provisioned and offers no sign-in", async () => {
    const vendor = worker.GatekeeperVendor({});
    expect(await vendor.describe()).toMatchObject({
      displayName: "Probe",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
  });

  it("mints accounts with no identity and serves self-contained types", async () => {
    const vendor = worker.GatekeeperVendor({});
    const created = await vendor.createAccount();
    expect(await created.describe()).toEqual(describeProbeAccount());
    const types = await vendor.getTypeScriptTypes();
    expect(types).toBe(TYPES_CODE);
    expect(types).toContain("export interface ProbeSession");
  });
});

describe("ProbeAccount", () => {
  it("declares an agent singleton and a sidebar app", async () => {
    expect(await account("acct-describe").describe()).toMatchObject({
      singleton: { tsType: "ProbeSession" },
      providesUi: { title: "Probe" },
    });
    expect(await account("acct-describe").getSupportedResources()).toEqual([]);
    expect(await account("acct-describe").getAuthenticatedEmail()).toBeNull();
    await expect((await account("acct-describe").getVerifier()).verify()).resolves.toBeUndefined();
  });

  it("serves the app page with its own CSP", async () => {
    const { iframeHtml } = await account("acct-page").startAppUi({ isAdmin: false });
    expect(iframeHtml).toContain("<title>Probe</title>");
    expect(iframeHtml).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src &#39;none&#39;/);
  });

  it("records the admin mark on every mount", async () => {
    const state = env.ACCOUNT_STATE.getByName("acct-mark");
    await account("acct-mark").startAppUi({ isAdmin: true });
    expect(await state.isMarkedAdmin()).toBe(true);
    await account("acct-mark").startAppUi({ isAdmin: false });
    expect(await state.isMarkedAdmin()).toBe(false);
    expect((await state.getAdminMark())?.isAdmin).toBe(false);
  });

  it("revoke() clears the account's state but keeps the studio's notes", async () => {
    const { ui } = await account("acct-revoke").startAppUi({ isAdmin: false });
    await ui.setDisplayName("Rita");
    const note = await ui.addNote("Stays after revoke");
    await account("acct-revoke").revoke();
    expect(await env.ACCOUNT_STATE.getByName("acct-revoke").getProfile()).toEqual({ displayName: null });
    expect(await store().getNote(note.id)).toMatchObject({ body: "Stays after revoke" });
  });
});

describe("the app's ui", () => {
  it("requires a display name before any edit", async () => {
    const { ui } = await account("acct-nameless").startAppUi({ isAdmin: false });
    expect(await ui.getViewer()).toEqual({ isAdmin: false, displayName: null });
    expect(await rejectionMessage(() => ui.addNote("hello")))
      .toMatch(/Set your display name before making changes/);
  });

  it("adds, lists and archives notes, signed with the display name", async () => {
    const { ui } = await account("acct-ada").startAppUi({ isAdmin: false });
    expect(await ui.setDisplayName("  Ada  ")).toEqual({ isAdmin: false, displayName: "Ada" });

    const note = await ui.addNote("  First line\nsecond line  ");
    expect(note).toMatchObject({
      body: "First line\nsecond line",
      author: { kind: "person", name: "Ada" },
      archivedAt: null,
      archivedBy: null,
    });
    expect((await ui.listNotes()).map((listed) => listed.id)).toContain(note.id);

    const archived = await ui.archiveNote(note.id);
    expect(archived.archivedBy).toBe("Ada");
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect((await ui.listNotes()).map((listed) => listed.id)).not.toContain(note.id);
    expect((await ui.listNotes({ includeArchived: true })).map((listed) => listed.id)).toContain(note.id);

    // Archiving again changes nothing.
    expect(await ui.archiveNote(note.id)).toEqual(archived);
  });

  it("validates input", async () => {
    const { ui } = await account("acct-validate").startAppUi({ isAdmin: false });
    await ui.setDisplayName("Val");
    expect(await rejectionMessage(() => ui.addNote("   "))).toMatch(/Note can't be empty/);
    expect(await rejectionMessage(() => ui.addNote("x".repeat(2001)))).toMatch(/at most 2000/);
    expect(await rejectionMessage(() => ui.archiveNote("not-an-id"))).toMatch(/not a valid id/);
    expect(await rejectionMessage(() => ui.archiveNote(crypto.randomUUID())))
      .toMatch(/no longer exists/);
    // @validateRpc checks types at the RPC boundary.
    expect(await rejectionMessage(() => ui.addNote(42 as unknown as string))).not.toBe("");
    expect(await rejectionMessage(() => ui.setDisplayName("‮"))).toMatch(/control or formatting/);
  });

  it("shows the audit log to admins only, with every human edit", async () => {
    const member = (await account("acct-audit").startAppUi({ isAdmin: false })).ui;
    expect(await rejectionMessage(() => member.listAuditLog()))
      .toMatch(/The audit log is available to admins only/);

    const { ui } = await account("acct-audit").startAppUi({ isAdmin: true });
    await ui.setDisplayName("Audrey");
    const note = await ui.addNote("Audited");
    await ui.archiveNote(note.id);
    await ui.archiveNote(note.id);

    const { entries } = await ui.listAuditLog({ limit: 200 });
    const mine = entries.filter((entry) => entry.actor.accountId === "acct-audit");
    expect(mine.map((entry) => entry.action)).toEqual(["note.archive", "note.add", "profile.set-name"]);
    expect(mine[0]).toMatchObject({
      target: note.id,
      actor: { kind: "person", name: "Audrey", isAdmin: true },
    });
    expect(mine[1].detail).toEqual({ body: "Audited" });
    expect(mine[2].detail).toEqual({ previous: null });
  });
});
