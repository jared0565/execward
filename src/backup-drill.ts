/**
 * What a restore drill has to show (task 4.1.3, NFR: recovery).
 *
 * The drill itself is `scripts/restore-drill.ts`: it downloads a real backup,
 * restores it into a scratch database and gathers the facts below. This file
 * only decides whether those facts add up to a restore that worked, so that
 * decision can be tested with made-up facts.
 */
import type { ChainCheck } from "./audit/log";
import { BACKUP_TABLES, type BackupDocument } from "./backup";

type Row = Record<string, unknown>;

export interface DrillFacts {
  /** The backup file, as downloaded and parsed. */
  readonly document: BackupDocument;
  /** The row counts production wrote in its audit log when it made the backup, if that entry was found. */
  readonly recordedRows: Record<string, number> | undefined;
  /** What `restore` said it wrote, by table. */
  readonly restored: Record<string, number>;
  /** Every backed-up table, read back from the scratch database after the restore. */
  readonly readBack: Record<string, readonly Row[]>;
  /** Whether the restored audit log's hash chain verifies. */
  readonly chain: ChainCheck;
  /** The last restored audit entry, and the hash production holds today for the entry with the same number. */
  readonly lastEntry: { readonly seq: number; readonly restoredHash: string; readonly productionHash: string | undefined } | undefined;
  /** A second restore into the now-filled database was refused. */
  readonly secondRestoreRefused: boolean;
  /** A copy of the backup with one character changed was refused. */
  readonly changedBackupRefused: boolean;
}

/**
 * Whether two rows hold the same values. The order of columns does not matter, and a column
 * one row lacks counts as empty: a backup taken before a migration added a column has no
 * such column, and the restored row holds nothing in it.
 */
function sameRow(a: Row, b: Row): boolean {
  const columns = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...columns].every((column) => JSON.stringify(a[column] ?? null) === JSON.stringify(b[column] ?? null));
}

/** Every way the drill's facts fall short of a working restore. Empty means it worked. */
export function drillProblems(facts: DrillFacts): string[] {
  const problems: string[] = [];
  if (facts.recordedRows === undefined) problems.push("production's audit log has no record of this backup, so its row counts could not be compared");
  for (const table of BACKUP_TABLES) {
    const inBackup = facts.document.tables[table];
    if (!Array.isArray(inBackup)) {
      problems.push(`the backup has no table "${table}"`);
      continue;
    }
    const recorded = facts.recordedRows?.[table];
    if (facts.recordedRows !== undefined && recorded !== inBackup.length) {
      problems.push(`"${table}": the backup holds ${inBackup.length} rows, but production recorded ${recorded ?? "none"} when it wrote it`);
    }
    if (facts.restored[table] !== inBackup.length) {
      problems.push(`"${table}": ${facts.restored[table] ?? 0} rows were restored, of ${inBackup.length} in the backup`);
    }
    const back = facts.readBack[table] ?? [];
    if (back.length !== inBackup.length) {
      problems.push(`"${table}": the scratch database holds ${back.length} rows after the restore, not ${inBackup.length}`);
      continue;
    }
    const differs = inBackup.findIndex((row, index) => !sameRow(row, back[index] ?? {}));
    if (differs !== -1) problems.push(`"${table}": row ${differs + 1} read back from the scratch database is not the row in the backup`);
  }
  if (!facts.chain.ok) problems.push(`the restored audit log's chain does not verify at entry ${facts.chain.seq}: ${facts.chain.reason}`);
  else if (facts.chain.entries !== (facts.document.tables.audit_log?.length ?? 0)) problems.push(`the chain check covered ${facts.chain.entries} entries, not every entry in the backup`);
  if (facts.lastEntry !== undefined) {
    if (facts.lastEntry.productionHash === undefined) problems.push(`production no longer holds audit entry ${facts.lastEntry.seq}, the last one in the backup`);
    else if (facts.lastEntry.productionHash !== facts.lastEntry.restoredHash) problems.push(`audit entry ${facts.lastEntry.seq} in the backup is not the entry production holds under that number`);
  }
  if (!facts.secondRestoreRefused) problems.push("a second restore over the restored rows was not refused");
  if (!facts.changedBackupRefused) problems.push("a changed copy of the backup was not refused");
  return problems;
}
