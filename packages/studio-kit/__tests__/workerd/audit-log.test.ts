import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AUDIT_LOG_MIGRATIONS,
  AuditLog,
  MAX_AUDIT_DETAIL_BYTES,
} from "../../src/audit-log.js";
import { appliedMigrations, migrate } from "../../src/sql.js";

const person = { kind: "person", accountId: "acct-1", name: "Ada", isAdmin: true } as const;
const agent = { kind: "agent", accountId: "acct-1", workspaceId: "ws-1" } as const;

function store(name: string) {
  return env.KIT_STORE.getByName(name);
}

describe("AuditLog", () => {
  it("appends rows and reads them newest first, in pages", async () => {
    await runInDurableObject(store("paging"), (_instance, state) => {
      migrate(state.storage, AUDIT_LOG_MIGRATIONS);
      let clock = 100;
      const log = new AuditLog(state.storage.sql, { now: () => clock++ });
      const first = log.append({ actor: person, action: "note.add", target: "n1", detail: { body: "hi" } });
      log.append({ actor: agent, action: "note.add", target: "n2" });
      log.append({ actor: person, action: "note.archive", target: "n1" });

      expect(first).toEqual({
        seq: 1, at: 100, actor: person, action: "note.add", target: "n1", detail: { body: "hi" },
      });

      const page = log.list({ limit: 2 });
      expect(page.entries.map((entry) => entry.seq)).toEqual([3, 2]);
      expect(page.entries[1]).toMatchObject({ actor: agent, target: "n2", detail: null });
      expect(page.nextBefore).toBe(2);

      const last = log.list({ limit: 2, before: page.nextBefore });
      expect(last.entries.map((entry) => entry.seq)).toEqual([1]);
      expect(last.nextBefore).toBeUndefined();
    });
  });

  it("refuses to update or delete a row", async () => {
    await runInDurableObject(store("append-only"), (_instance, state) => {
      migrate(state.storage, AUDIT_LOG_MIGRATIONS);
      new AuditLog(state.storage.sql).append({ actor: person, action: "note.add", target: "n1" });
      expect(() => state.storage.sql.exec("UPDATE studio_audit_log SET target = 'forged'"))
        .toThrow(/append-only/);
      expect(() => state.storage.sql.exec("DELETE FROM studio_audit_log")).toThrow(/append-only/);
      expect(new AuditLog(state.storage.sql).list().entries).toHaveLength(1);
    });
  });

  it("validates actions, detail size and paging arguments", async () => {
    await runInDurableObject(store("validation"), (_instance, state) => {
      migrate(state.storage, AUDIT_LOG_MIGRATIONS);
      const log = new AuditLog(state.storage.sql);
      expect(() => log.append({ actor: person, action: "Add Note" })).toThrow(/dotted lowercase/);
      expect(() => log.append({ actor: person, action: "add" })).toThrow(/dotted lowercase/);
      expect(() => log.append({
        actor: person, action: "note.add", detail: { body: "x".repeat(MAX_AUDIT_DETAIL_BYTES) },
      })).toThrow(/exceeds/);
      expect(() => log.list({ limit: 0 })).toThrow(/page size/);
      expect(() => log.list({ before: -1 })).toThrow(/cursor/);
      expect(log.list().entries).toEqual([]);
    });
  });
});

describe("migrate", () => {
  it("applies each step once, in order, and records it", async () => {
    await runInDurableObject(store("migrations"), (_instance, state) => {
      const steps = [
        ...AUDIT_LOG_MIGRATIONS,
        { id: "test-0001-things", sql: ["CREATE TABLE things (id TEXT PRIMARY KEY)"] },
      ];
      expect(appliedMigrations(state.storage)).toEqual([]);
      expect(migrate(state.storage, steps)).toEqual(["studio-kit-0001-audit-log", "test-0001-things"]);
      expect(migrate(state.storage, steps)).toEqual([]);

      const next = [...steps, { id: "test-0002-more", sql: ["ALTER TABLE things ADD COLUMN name TEXT"] }];
      expect(migrate(state.storage, next)).toEqual(["test-0002-more"]);
      expect(appliedMigrations(state.storage))
        .toEqual(["studio-kit-0001-audit-log", "test-0001-things", "test-0002-more"]);
    });
  });

  it("rolls a failing step back with its record", async () => {
    await runInDurableObject(store("failing"), (_instance, state) => {
      const broken = [
        { id: "test-0001-ok", sql: ["CREATE TABLE ok (id TEXT)"] },
        { id: "test-0002-broken", sql: ["CREATE TABLE half (id TEXT)", "NOT SQL"] },
      ];
      expect(() => migrate(state.storage, broken)).toThrow();
      expect(appliedMigrations(state.storage)).toEqual([]);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('ok', 'half')").one().n).toBe(0);
    });
  });

  it("refuses duplicate step ids", async () => {
    await runInDurableObject(store("duplicates"), (_instance, state) => {
      expect(() => migrate(state.storage, [
        { id: "same", sql: [] },
        { id: "same", sql: [] },
      ])).toThrow(/Duplicate/);
    });
  });
});
