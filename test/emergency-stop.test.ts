import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore, verifyChain } from "../src/audit/log";
import { ownerConsole, type Principal } from "../src/console/console";
import { memoryControlStore, runGate } from "../src/console/control";
import { EMERGENCY_ACTOR, emergencyStop } from "../src/console/emergency";
import { cliDatabase, inlineSql, sqlLiteral } from "../src/storage/cli-database";

const NOW = Date.UTC(2026, 10, 24, 10);
const OWNER: Principal = { kind: "owner", id: "owner:1", twoFactorAt: NOW - 1000 };

function setup() {
  const control = memoryControlStore();
  const store = memoryAuditStore();
  const audit = auditLog(store, () => NOW);
  return { control, store, audit, console_: ownerConsole({ control, audit, now: () => NOW }) };
}

describe("the emergency stop (incident runbook step 1, FR-27)", () => {
  it("sets the kill switch, so nothing runs, and writes it to the audit log on the chain", async () => {
    const { control, store, audit, console_ } = setup();
    await console_.completeOnboarding(OWNER, { profile: "formal" });
    await console_.setCodeMode(OWNER, true);
    expect(await runGate(control)("acme")).toBeUndefined();

    const result = await emergencyStop({ control, audit }, "  owner's phone lost, tool misbehaving  ");
    expect(result.changed).toBe(true);
    expect(result.after).toMatchObject({ killed: true, version: 3 });
    expect((await runGate(control)("acme"))?.code).toBe("code_mode_off");

    const entry = store.entries.at(-1);
    expect(entry?.kind).toBe("console_change");
    expect(JSON.parse(entry?.content ?? "{}")).toMatchObject({ action: "kill", by: EMERGENCY_ACTOR, reason: "owner's phone lost, tool misbehaving", version: 3 });
    expect(await verifyChain(store.entries)).toEqual({ ok: true, entries: 3 });
  });

  it("does not wait for a reason", async () => {
    const { control, audit } = setup();
    expect((await emergencyStop({ control, audit }, "   ")).after.killed).toBe(true);
  });

  it("changes nothing, and writes nothing, when the kill switch is already set", async () => {
    const { control, store, audit } = setup();
    await emergencyStop({ control, audit }, "first");
    const again = await emergencyStop({ control, audit }, "second");
    expect(again.changed).toBe(false);
    expect(control.current().version).toBe(1);
    expect(store.entries).toHaveLength(1);
  });

  it("leaves everything else as it was: it only stops", async () => {
    const { control, audit, console_ } = setup();
    await console_.completeOnboarding(OWNER, { profile: "lightweight" });
    await console_.setCodeMode(OWNER, true);
    await console_.pauseProject(OWNER, "acme", "under review");
    const before = control.current();
    const { after } = await emergencyStop({ control, audit }, "x");
    expect({ ...after, killed: false, version: before.version }).toEqual(before);
  });

  it("can be undone only from the console, by the signed-in owner, with a reason", async () => {
    const { control, audit, console_ } = setup();
    await emergencyStop({ control, audit }, "x");
    await expect(console_.clearKill({ kind: "anonymous" }, "all clear")).rejects.toThrow();
    await expect(console_.clearKill(OWNER, "")).rejects.toThrow("a reason is required");
    expect((await console_.clearKill(OWNER, "phone replaced, cause fixed")).killed).toBe(false);
  });
});

describe("writing values into SQL for a command line", () => {
  it("writes numbers, empty values and text, doubling every quote", () => {
    expect(sqlLiteral(7)).toBe("7");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral("plain")).toBe("'plain'");
    expect(sqlLiteral("owner's phone")).toBe("'owner''s phone'");
    expect(sqlLiteral("'; DROP TABLE audit_log; --")).toBe("'''; DROP TABLE audit_log; --'");
    expect(sqlLiteral('{"a":"b"}')).toBe(`'{"a":"b"}'`);
  });

  it.each<[string, unknown]>([
    ["a number that is not finite", Number.NaN],
    ["a missing value", undefined],
    ["an object", { a: 1 }],
    ["a true or false", true],
    ["text with a NUL character", "a\0b"],
  ])("refuses %s", (_label, value) => {
    expect(() => sqlLiteral(value)).toThrow();
  });

  it("puts each value where its number is, in any order and more than once", () => {
    expect(inlineSql("UPDATE t SET v = ?1, s = ?2 WHERE id = 1 AND v = ?3", [4, "x", 3])).toBe("UPDATE t SET v = 4, s = 'x' WHERE id = 1 AND v = 3");
    expect(inlineSql("SELECT ?2, ?1, ?2", ["a", "b"])).toBe("SELECT 'b', 'a', 'b'");
    expect(inlineSql("SELECT 1", [])).toBe("SELECT 1");
  });

  it("leaves a question mark inside the statement's own quoted text alone", () => {
    expect(inlineSql("SELECT 'what?1' WHERE id = ?1", [5])).toBe("SELECT 'what?1' WHERE id = 5");
  });

  it("does not let a value's own question mark be read as a placeholder", () => {
    expect(inlineSql("INSERT INTO t VALUES (?1, ?2)", ["is it ?2", "safe"])).toBe("INSERT INTO t VALUES ('is it ?2', 'safe')");
  });

  it.each<[string, string, unknown[]]>([
    ["a value the statement does not use", "SELECT ?1", [1, 2]],
    ["a placeholder with no value", "SELECT ?1, ?2", [1]],
    ["a placeholder numbered zero", "SELECT ?0", [1]],
    ["a placeholder with no number", "SELECT ?", [1]],
  ])("refuses %s", (_label, sql, values) => {
    expect(() => inlineSql(sql, values)).toThrow();
  });

  it("gives the stores a database: first row, every row, and how many rows changed", async () => {
    const seen: string[] = [];
    const db = cliDatabase(async (sql) => {
      seen.push(sql);
      return sql.startsWith("SELECT") ? { results: [{ n: 1 }, { n: 2 }], changes: 0 } : { results: [], changes: 3 };
    });
    expect(await db.prepare("SELECT n FROM t WHERE a = ?1").bind("x").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT n FROM t").all()).toEqual({ results: [{ n: 1 }, { n: 2 }] });
    expect(await db.prepare("DELETE FROM t WHERE a < ?1").bind(9).run()).toEqual({ meta: { changes: 3 } });
    expect(await db.prepare("UPDATE t SET a = ?1 RETURNING a").bind(1).first()).toBeNull();
    expect(seen).toEqual(["SELECT n FROM t WHERE a = 'x'", "SELECT n FROM t", "DELETE FROM t WHERE a < 9", "UPDATE t SET a = 1 RETURNING a"]);
  });
});
