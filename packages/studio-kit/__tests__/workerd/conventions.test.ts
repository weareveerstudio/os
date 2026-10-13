import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { defineActions } from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it } from "vitest";
import {
  AGENT_WRITE_POLICY,
  APPLIED_ACTIONS_MIGRATIONS,
  AppliedActions,
  actionKind,
  agentWrite,
  appliedActionKey,
} from "../../src/actions.js";
import { studioAccountDescription, studioVendorDescription, svgIcon } from "../../src/describe.js";
import { requireAdmin, requireId, requireText } from "../../src/guards.js";
import { BASELINE, observation } from "../../src/observers.js";
import { migrate } from "../../src/sql.js";
import { SHARED_STORE_NAME, sharedStore, storeName } from "../../src/stores.js";

describe("action conventions", () => {
  it("namespaces kinds by gate", () => {
    expect(actionKind("probe", "add-note", "Add a Probe note"))
      .toEqual({ tag: "probe.add-note", label: "Add a Probe note" });
    expect(() => actionKind("Probe", "add", "x")).toThrow(/lowercase/);
    expect(() => actionKind("probe", "add", " ")).toThrow(/label/);
  });

  it("makes every agent write auto-approvable with simulation", () => {
    const kind = actionKind("probe", "add-note", "Add a Probe note");
    const definition = agentWrite<{ body: string }, unknown>({
      kind,
      describe: () => ({ title: "Add", description: "Adds.", implementsRevert: false }),
      apply: async () => {},
    });
    expect(definition).toMatchObject(AGENT_WRITE_POLICY);
    expect(() => agentWrite({
      kind,
      delivery: "await-decision",
      describe: () => ({ title: "Add", description: "Adds.", implementsRevert: false }),
      apply: async () => {},
    } as never)).toThrow(/sets autoApprovable and delivery itself/);

    const actions = defineActions<unknown, { addNote: { body: string } }>(
      { addNote: definition }, { fence: "none" });
    expect(actions.bind({} as never, {}).autoApprovableKinds()).toEqual([kind]);
  });

  it("keys applied actions by workspace and action id", () => {
    expect(appliedActionKey("ws-1", 7)).toBe("ws-1:7");
    expect(() => appliedActionKey("", 1)).toThrow(/workspace id/);
    expect(() => appliedActionKey("ws-1", 0)).toThrow(/positive integer/);
  });

  it("claims each applied action once", async () => {
    await runInDurableObject(env.KIT_STORE.getByName("applied"), (_instance, state) => {
      migrate(state.storage, APPLIED_ACTIONS_MIGRATIONS);
      const applied = new AppliedActions(state.storage.sql);
      expect(applied.has("ws-1:1")).toBe(false);
      expect(applied.claim("ws-1:1")).toBe(true);
      expect(applied.claim("ws-1:1")).toBe(false);
      expect(applied.claim("ws-2:1")).toBe(true);
      expect(applied.has("ws-1:1")).toBe(true);
    });
  });
});

describe("observations", () => {
  it("puts values in fields and keeps prose the gate's own", () => {
    const input = observation("Read a note", "Read one note.", (b) => b.inline("Note ID", "n-1"));
    expect(input.title).toBe("Read a note");
    expect(input.description).toContain("Read one note.");
    expect(input.fields).toEqual([{ kind: "inline", label: "Note ID", value: "n-1" }]);
    expect(input).not.toHaveProperty("descriptionIsComplete");
    expect(input).not.toHaveProperty("containsRestrictedData");
    expect(BASELINE).toEqual({ kind: "baseline" });
  });

  it("marks restricted reads", () => {
    expect(observation("Read invoices", "Read invoices.", undefined, { restricted: true }))
      .toMatchObject({ containsRestrictedData: true });
  });
});

describe("descriptions", () => {
  const icon = svgIcon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/>");

  it("builds monochrome data-URL icons", () => {
    expect(icon.url.startsWith("data:image/svg+xml,%3Csvg")).toBe(true);
    expect(() => svgIcon("<div/>")).toThrow(/xmlns/);
  });

  it("describes an auto-provisioned vendor and a singleton account with an app", () => {
    expect(studioVendorDescription({
      displayName: "Probe", tagline: "t", description: "d", logo: icon,
    })).toMatchObject({ autoProvisionsAccount: true, providesAuth: false });
    expect(studioAccountDescription({
      displayName: "Probe", icon, tsType: "ProbeSession", appTitle: "Probe",
    })).toEqual({
      displayName: "Probe",
      avatar: icon,
      singleton: { tsType: "ProbeSession" },
      providesUi: { title: "Probe", icon },
    });
  });
});

describe("guards", () => {
  it("checks admin status", () => {
    expect(() => requireAdmin(false, "The audit log")).toThrow("The audit log is available to admins only.");
    expect(() => requireAdmin(true, "The audit log")).not.toThrow();
  });

  it("trims and bounds text", () => {
    expect(requireText("  hello\r\nthere  ", { label: "Note", max: 20, multiline: true }))
      .toBe("hello\nthere");
    expect(() => requireText("a\nb", { label: "Name", max: 20 })).toThrow(/control/);
    expect(() => requireText("", { label: "Note", max: 20 })).toThrow("Note can't be empty.");
    expect(() => requireText("x".repeat(21), { label: "Note", max: 20 })).toThrow(/at most 20/);
    expect(() => requireText("a​b", { label: "Note", max: 20, multiline: true }))
      .toThrow(/formatting/);
    expect(() => requireText(5, { label: "Note", max: 20 })).toThrow(/must be text/);
  });

  it("accepts only minted ids", () => {
    const id = crypto.randomUUID();
    expect(requireId(id, "Note")).toBe(id);
    expect(() => requireId("../etc", "Note")).toThrow("Note is not a valid id.");
  });
});

describe("store names", () => {
  it("uses one fixed name per store class", async () => {
    expect(storeName("2027")).toBe(`${SHARED_STORE_NAME}:2027`);
    expect(() => storeName("Bad Name")).toThrow(/lowercase/);
    expect(sharedStore(env.KIT_STORE).id.toString())
      .toBe(env.KIT_STORE.idFromName(SHARED_STORE_NAME).toString());
  });
});
