/**
 * The restore drill (task 4.1.3, NFR: recovery): proves that a real production
 * backup can be restored.
 *
 *   npm run restore:drill                     the latest backup
 *   npm run restore:drill -- --day 2026-11-28 the backup of one day
 *
 * Needs a signed-in Wrangler. It reads production and writes nothing there. It
 * downloads the backup, restores it with the same `restore` the Worker has into
 * a scratch database that exists only in this process's memory, and checks the
 * result. The downloaded file is deleted before the command ends, because a
 * backup holds the audit log.
 *
 * The scratch database is local SQLite with this repository's migrations. D1
 * is SQLite too, and a restore on a real D1 database is covered, with test
 * content, by `test/deployed/backup.deployed.ts`.
 *
 * Exits 1 if anything does not add up.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditExport, type AuditRow } from "../src/audit/export";
import type { ChainAnchor } from "../src/audit/log";
import { BACKUP_TABLES, BackupError, restore, type BackupBucket, type BackupDatabase, type BackupDocument } from "../src/backup";
import { drillProblems } from "../src/backup-drill";

const DATABASE = "execward";
const BUCKET = "execward-backups";
const WRANGLER = "node_modules/wrangler/bin/wrangler.js";

type Row = Record<string, unknown>;

const args = process.argv.slice(2);
const dayAt = args.indexOf("--day");
const day = dayAt === -1 ? undefined : args[dayAt + 1];
if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day needs a date like 2026-11-28");

function wrangler(rest: readonly string[]): string {
  return execFileSync(process.execPath, [WRANGLER, ...rest], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 });
}

function production<T>(sql: string): T[] {
  const out = wrangler(["d1", "execute", DATABASE, "--remote", "--json", "--command", sql]);
  const start = out.search(/[[{]/);
  if (start === -1) throw new Error("the database query printed no JSON");
  const first = (JSON.parse(out.slice(start)) as { results?: T[]; success?: boolean }[])[0];
  if (!first || first.success === false || !Array.isArray(first.results)) throw new Error("the database query did not succeed");
  return first.results;
}

interface Recorded {
  readonly key: string;
  readonly rows: Record<string, number>;
  readonly sha256: string;
}

/** What production wrote in its audit log about its backups, newest first. */
function recordedBackups(): Recorded[] {
  const found: Recorded[] = [];
  for (const { content } of production<{ content: string }>("SELECT content FROM audit_log WHERE kind = 'maintenance' ORDER BY seq DESC LIMIT 200")) {
    try {
      const backup = (JSON.parse(content) as { backup?: Partial<Recorded> }).backup;
      if (typeof backup?.key === "string" && typeof backup.sha256 === "string" && typeof backup.rows === "object") found.push(backup as Recorded);
    } catch {
      // An entry that is not JSON says nothing about a backup.
    }
  }
  return found;
}

/** A scratch database with the repository's tables, empty, behind the interface `restore` writes to. */
function scratchDatabase(): { readonly db: BackupDatabase; read(table: string): Row[] } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join("migrations", file), "utf8"));
  const plain = (rows: unknown[]): Row[] => rows.map((row) => ({ ...(row as Row) }));
  type Value = null | number | bigint | string;
  return {
    db: {
      prepare: (sql) => ({
        bind: (...values) => ({
          all: <T = Row>() => Promise.resolve({ results: plain(sqlite.prepare(sql).all(...(values as Value[]))) as T[] }),
          run: () => Promise.resolve(sqlite.prepare(sql).run(...(values as Value[]))),
        }),
      }),
    },
    read: (table) => plain(sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
  };
}

/** A bucket that holds one object: the downloaded backup, with the hash recorded for it. */
function oneObjectBucket(key: string, text: string, sha256: string): BackupBucket {
  const refuse = (): never => {
    throw new Error("the drill only reads");
  };
  return { put: refuse, list: refuse, delete: refuse, get: (asked) => Promise.resolve(asked === key ? { text: () => Promise.resolve(text), customMetadata: { sha256 } } : null) };
}

async function refused(attempt: () => Promise<unknown>): Promise<boolean> {
  try {
    await attempt();
    return false;
  } catch (error) {
    if (error instanceof BackupError) return true;
    throw error;
  }
}

const recorded = recordedBackups();
const wantedKey = day === undefined ? recorded[0]?.key : `backups/${day}.json`;
if (wantedKey === undefined) throw new Error("production's audit log records no backup; give a day with --day");
const record = recorded.find((backup) => backup.key === wantedKey);

const folder = mkdtempSync(join(tmpdir(), "execward-restore-drill-"));
try {
  const file = join(folder, "backup.json");
  wrangler(["r2", "object", "get", `${BUCKET}/${wantedKey}`, "--remote", "--file", file]);
  const text = readFileSync(file, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  console.log(`Restore drill for ${wantedKey} (${Buffer.byteLength(text)} bytes)`);
  console.log(`  The file's hash:       ${sha256}`);
  console.log(`  Production recorded:   ${record?.sha256 ?? "nothing: no audit entry names this backup"}`);

  // The hash `restore` checks the file against is the one production recorded, not one worked out here from the same file.
  const bucket = oneObjectBucket(wantedKey, text, record?.sha256 ?? "");
  const scratch = scratchDatabase();
  const restored = await restore(scratch.db, bucket, wantedKey);
  const readBack = Object.fromEntries(BACKUP_TABLES.map((table) => [table, scratch.read(table)]));
  const secondRestoreRefused = await refused(() => restore(scratch.db, bucket, wantedKey));
  const changed = text.replace(/\d/, (digit) => String((Number(digit) + 1) % 10));
  const changedBackupRefused = await refused(() => restore(scratchDatabase().db, oneObjectBucket(wantedKey, changed, record?.sha256 ?? ""), wantedKey));

  const log = readBack.audit_log as unknown as AuditRow[];
  const anchor = (readBack.audit_anchor as unknown as (ChainAnchor & { id?: number })[]).find((row) => row.id === 1 || row.id === undefined);
  const chain = (await auditExport(log, anchor, "restore drill")).check;
  const last = log.at(-1);
  const lastEntry =
    last === undefined
      ? undefined
      : { seq: Number(last.seq), restoredHash: String(last.hash), productionHash: production<{ hash: string }>(`SELECT hash FROM audit_log WHERE seq = ${Number(last.seq)}`)[0]?.hash };

  const document = JSON.parse(text) as BackupDocument;
  console.log(`  Taken at:              ${document.takenAt}`);
  for (const table of BACKUP_TABLES) console.log(`  ${`${table}:`.padEnd(22)} ${restored[table] ?? 0} rows restored and read back`);
  console.log(`  Audit chain:           ${chain.ok ? `verifies, ${chain.entries} entries` : `DOES NOT VERIFY at entry ${chain.seq}`}`);
  if (lastEntry) console.log(`  Last entry (${lastEntry.seq}):      ${lastEntry.productionHash === lastEntry.restoredHash ? "the same entry production holds" : "NOT what production holds"}`);
  console.log(`  Second restore:        ${secondRestoreRefused ? "refused, as it should be" : "NOT refused"}`);
  console.log(`  Changed copy:          ${changedBackupRefused ? "refused, as it should be" : "NOT refused"}`);

  const problems = drillProblems({ document, recordedRows: record?.rows, restored, readBack, chain, lastEntry, secondRestoreRefused, changedBackupRefused });
  if (problems.length === 0) {
    console.log("The restore worked: every row came back as it was in the backup.");
  } else {
    console.error("THE RESTORE DRILL FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
