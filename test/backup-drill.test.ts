import { describe, expect, it } from "vitest";
import { BACKUP_TABLES, type BackupDocument } from "../src/backup";
import { drillProblems, type DrillFacts } from "../src/backup-drill";

type Row = Record<string, unknown>;

function tables(): Record<string, Row[]> {
  return {
    policy: [{ path: "github_get_repository", record: "{}" }],
    audit_log: [
      { seq: 1, hash: "aa" },
      { seq: 2, hash: "bb" },
    ],
    audit_anchor: [],
    escalations: [{ id: "e1", status: "resolved" }],
    control_state: [{ id: 1, version: 6, state: "{}" }],
    projects: [{ project: "work", data_class: "internal", client_ai_use: null }],
  };
}

const counts = (from: Record<string, Row[]>): Record<string, number> => Object.fromEntries(Object.entries(from).map(([table, rows]) => [table, rows.length]));

/** The facts of a restore that worked. */
function good(): { -readonly [K in keyof DrillFacts]: DrillFacts[K] } {
  const document: BackupDocument = { version: 1, takenAt: "2026-11-28T00:00:19.000Z", tables: tables() };
  return {
    document,
    recordedRows: counts(tables()),
    restored: counts(tables()),
    readBack: tables(),
    chain: { ok: true, entries: 2 },
    lastEntry: { seq: 2, restoredHash: "bb", productionHash: "bb" },
    secondRestoreRefused: true,
    changedBackupRefused: true,
  };
}

describe("deciding whether a restore drill worked (task 4.1.3)", () => {
  it("finds nothing wrong when every row came back and every check held", () => {
    expect(drillProblems(good())).toEqual([]);
  });

  it("covers every table a backup holds", () => {
    expect(Object.keys(tables()).sort()).toEqual([...BACKUP_TABLES].sort());
  });

  it("does not mind the order of a row's columns, or a missing value read back as null", () => {
    const facts = good();
    facts.readBack = { ...tables(), projects: [{ client_ai_use: null, data_class: "internal", project: "work" }], escalations: [{ status: "resolved", id: "e1", note: null }] };
    facts.document = { ...facts.document, tables: { ...tables(), escalations: [{ id: "e1", status: "resolved", note: undefined }] } };
    expect(drillProblems(facts)).toEqual([]);
  });

  it("accepts a backup taken before a migration added a column: the restored row holds nothing there", () => {
    const facts = good();
    facts.document = { ...facts.document, tables: { ...tables(), projects: [{ project: "work", data_class: "internal" }] } };
    expect(drillProblems(facts)).toEqual([]);
    // A value the backup does hold must still come back.
    facts.readBack = { ...tables(), projects: [{ project: "work", data_class: null, client_ai_use: null }] };
    expect(drillProblems(facts)).toEqual(['"projects": row 1 read back from the scratch database is not the row in the backup']);
  });

  it("reports a row that came back changed", () => {
    const facts = good();
    facts.readBack = { ...tables(), audit_log: [{ seq: 1, hash: "aa" }, { seq: 2, hash: "XX" }] };
    expect(drillProblems(facts)).toEqual(['"audit_log": row 2 read back from the scratch database is not the row in the backup']);
  });

  it("reports rows that did not come back", () => {
    const facts = good();
    facts.readBack = { ...tables(), policy: [] };
    facts.restored = { ...counts(tables()), policy: 0 };
    expect(drillProblems(facts)).toEqual(['"policy": 0 rows were restored, of 1 in the backup', '"policy": the scratch database holds 0 rows after the restore, not 1']);
  });

  it("reports a backup that lacks a table", () => {
    const facts = good();
    const rest = tables();
    delete rest.escalations;
    facts.document = { ...facts.document, tables: rest };
    expect(drillProblems(facts)).toContain('the backup has no table "escalations"');
  });

  it("reports a backup whose row counts are not the ones production recorded, or that production never recorded", () => {
    const facts = good();
    facts.recordedRows = { ...counts(tables()), audit_log: 3 };
    expect(drillProblems(facts)).toEqual(['"audit_log": the backup holds 2 rows, but production recorded 3 when it wrote it']);
    facts.recordedRows = undefined;
    expect(drillProblems(facts)).toEqual(["production's audit log has no record of this backup, so its row counts could not be compared"]);
  });

  it("reports a chain that does not verify, or a check that did not cover every entry", () => {
    const facts = good();
    facts.chain = { ok: false, seq: 2, reason: "the entry was changed" };
    expect(drillProblems(facts)).toEqual(["the restored audit log's chain does not verify at entry 2: the entry was changed"]);
    facts.chain = { ok: true, entries: 1 };
    expect(drillProblems(facts)).toEqual(["the chain check covered 1 entries, not every entry in the backup"]);
  });

  it("reports a backup whose last entry is not production's, since it may be another database's", () => {
    const facts = good();
    facts.lastEntry = { seq: 2, restoredHash: "bb", productionHash: "cc" };
    expect(drillProblems(facts)).toEqual(["audit entry 2 in the backup is not the entry production holds under that number"]);
    facts.lastEntry = { seq: 2, restoredHash: "bb", productionHash: undefined };
    expect(drillProblems(facts)).toEqual(["production no longer holds audit entry 2, the last one in the backup"]);
  });

  it("reports a restore that could be run twice, or that took a changed backup", () => {
    const facts = good();
    facts.secondRestoreRefused = false;
    facts.changedBackupRefused = false;
    expect(drillProblems(facts)).toEqual(["a second restore over the restored rows was not refused", "a changed copy of the backup was not refused"]);
  });

  it("accepts a backup of an empty audit log, which has no last entry to compare", () => {
    const facts = good();
    const empty = { ...tables(), audit_log: [] };
    facts.document = { ...facts.document, tables: empty };
    facts.recordedRows = counts(empty);
    facts.restored = counts(empty);
    facts.readBack = empty;
    facts.chain = { ok: true, entries: 0 };
    facts.lastEntry = undefined;
    expect(drillProblems(facts)).toEqual([]);
  });
});
