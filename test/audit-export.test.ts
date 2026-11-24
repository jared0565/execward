import { describe, expect, it } from "vitest";
import { auditExport, recheck, rowsToEntries, type AuditRow } from "../src/audit/export";
import { auditLog, memoryAuditStore, type AuditEntry } from "../src/audit/log";

const NOW = Date.UTC(2026, 10, 24, 9);

async function entries(count: number): Promise<AuditEntry[]> {
  const store = memoryAuditStore();
  const log = auditLog(store, () => NOW);
  for (let index = 0; index < count; index++) {
    await log.record({ kind: index % 2 === 0 ? "console_change" : "maintenance", runId: `run-${index}`, project: "acme", body: { step: index } });
  }
  return store.entries;
}

/** An entry as the database returns it. */
function row(entry: AuditEntry): AuditRow {
  return {
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    run_id: entry.runId,
    project: entry.project,
    security: entry.security ? 1 : 0,
    content: entry.content,
    content_hash: entry.contentHash,
    prev_hash: entry.prevHash,
    hash: entry.hash,
  };
}

describe("exporting the audit log (incident runbook step 3)", () => {
  it("copies every entry and says the chain verifies", async () => {
    const original = await entries(5);
    const exported = await auditExport(original.map(row), undefined, "production", new Date(NOW));
    expect(exported.check).toEqual({ ok: true, entries: 5 });
    expect(exported.entries).toEqual(original);
    expect(exported.kinds).toEqual({ console_change: 3, maintenance: 2 });
    expect(exported.source).toBe("production");
    expect(exported.exportedAt).toBe("2026-11-24T09:00:00.000Z");
    expect(exported.first).toBe(original[0]?.at);
    expect(exported.last).toBe(original[4]?.at);
  });

  it("puts the rows in order whatever order they arrive in", async () => {
    const original = await entries(4);
    const exported = await auditExport([...original].reverse().map(row), undefined, "production");
    expect(exported.check.ok).toBe(true);
    expect(exported.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("is an empty copy that verifies when nothing has been written", async () => {
    const exported = await auditExport([], undefined, "production");
    expect(exported).toMatchObject({ check: { ok: true, entries: 0 }, entries: [], first: null, last: null, kinds: {} });
  });

  it.each<[string, (rows: AuditRow[]) => AuditRow[], number]>([
    ["an entry removed from the middle", (rows) => rows.filter((_, index) => index !== 2), 4],
    ["an entry's content changed", (rows) => rows.map((entry, index) => (index === 1 ? { ...entry, content: '{"step":99}' } : entry)), 2],
    ["an entry's project changed", (rows) => rows.map((entry, index) => (index === 3 ? { ...entry, project: "other" } : entry)), 4],
    ["an entry's time changed", (rows) => rows.map((entry, index) => (index === 0 ? { ...entry, at: "2020-01-01T00:00:00.000Z" } : entry)), 1],
    ["the first entry removed", (rows) => rows.slice(1), 2],
  ])("says the chain does not verify with %s, and where", async (_label, tamper, seq) => {
    const exported = await auditExport(tamper((await entries(5)).map(row)), undefined, "production");
    expect(exported.check).toMatchObject({ ok: false, seq });
  });

  it("does not notice the newest entries being cut off, which is why a copy is kept elsewhere", async () => {
    // A chain proves what is there is whole. It cannot prove nothing was dropped from the end.
    const exported = await auditExport((await entries(5)).map(row).slice(0, 3), undefined, "production");
    expect(exported.check).toEqual({ ok: true, entries: 3 });
  });

  it("starts from the anchor once old entries have been removed", async () => {
    const original = await entries(5);
    const anchor = { seq: 2, hash: original[1]?.hash ?? "" };
    const exported = await auditExport(original.slice(2).map(row), anchor, "production");
    expect(exported.check).toEqual({ ok: true, entries: 3 });
    expect((await auditExport(original.slice(2).map(row), { seq: 2, hash: "0".repeat(64) }, "production")).check.ok).toBe(false);
  });

  it("checks a saved copy again from its own entries", async () => {
    const exported = await auditExport((await entries(4)).map(row), undefined, "production");
    const saved = JSON.parse(JSON.stringify(exported)) as typeof exported;
    expect(await recheck(saved)).toEqual({ ok: true, entries: 4 });
    const edited = { ...saved, entries: saved.entries.map((entry, index) => (index === 2 ? { ...entry, kind: "nothing_happened" } : entry)) };
    expect(await recheck(edited)).toMatchObject({ ok: false, seq: 3 });
  });

  it("keeps an entry whose content has been expired, as empty", async () => {
    const original = await entries(3);
    const rows = original.map(row).map((entry, index) => (index === 0 ? { ...entry, content: null } : entry));
    const exported = await auditExport(rows, undefined, "production");
    expect(exported.check.ok).toBe(true);
    expect(exported.entries[0]?.content).toBeNull();
  });

  it.each<[string, Partial<Record<keyof AuditRow, unknown>>]>([
    ["no position", { seq: "1" }],
    ["a position that is not a whole number", { seq: 1.5 }],
    ["a hash that is not text", { hash: 5 }],
    ["content that is neither text nor empty", { content: { step: 1 } }],
    ["no time", { at: undefined }],
  ])("stops rather than copy a row with %s", async (_label, damage) => {
    const rows = (await entries(1)).map(row).map((entry) => ({ ...entry, ...damage }));
    expect(() => rowsToEntries(rows)).toThrow();
  });
});
