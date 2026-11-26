/**
 * Daily backup of the database to object storage, and restore (task 1.4.5,
 * NFR: recovery).
 *
 * A backup is one JSON document holding every row of the tables that cannot
 * be rebuilt: the policy, the audit log and its anchor, the escalation queue,
 * the owner's switches and the project records. Quota counters are left out;
 * they are short-lived and start again from zero.
 *
 * Backups are kept for `BACKUP_KEEP_DAYS` and then deleted. That is short on
 * purpose: a backup holds audit text as it was on its day, so text that
 * retention or an erasure request has since removed lives on in backups until
 * they are deleted. The client notice has to say so.
 */
export const BACKUP_TABLES = ["policy", "audit_log", "audit_anchor", "escalations", "control_state", "projects"] as const;
export const BACKUP_KEEP_DAYS = 7;
export const BACKUP_PREFIX = "backups/";
const PAGE_ROWS = 500;
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

export interface BackupDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T = Row>(): Promise<{ results: T[] }>; run(): Promise<unknown> };
  };
}

/** The part of an R2 bucket the backup uses. */
export interface BackupBucket {
  put(key: string, value: string, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; customMetadata?: Record<string, string> } | null>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<unknown>;
}

export interface BackupDocument {
  readonly version: 1;
  readonly takenAt: string;
  readonly tables: Record<string, Row[]>;
}

export interface BackupResult {
  readonly key: string;
  readonly rows: Record<string, number>;
  readonly bytes: number;
  readonly sha256: string;
  /** Older backups deleted in the same pass. */
  readonly pruned: number;
}

export class BackupError extends Error {
  override readonly name = "BackupError";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The key of the backup taken on a day: `backups/2026-11-23.json`. */
export function backupKey(ms: number): string {
  return `${BACKUP_PREFIX}${dayOf(ms)}.json`;
}

/**
 * The key of the note, beside a day's backup, that a clean-up job of that day's round failed
 * and is still owed (see ./worker/scheduled.ts). Not a backup: it holds job names only.
 */
export function retryKey(ms: number): string {
  return `${backupKey(ms)}.retry`;
}

async function readTable(db: BackupDatabase, table: string): Promise<Row[]> {
  const rows: Row[] = [];
  let after = 0;
  for (;;) {
    // In pages, by row id: one query for a whole table can be more than the database will return.
    const page = (await db.prepare(`SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ${PAGE_ROWS}`).bind(after).all<Row>()).results;
    for (const { __rowid, ...row } of page) {
      rows.push(row);
      after = Number(__rowid);
    }
    if (page.length < PAGE_ROWS) return rows;
  }
}

/** Writes today's backup, replacing an earlier one from the same day, then deletes backups past their keep time. */
export async function backUp(db: BackupDatabase, bucket: BackupBucket, now: number): Promise<BackupResult> {
  const tables: Record<string, Row[]> = {};
  for (const table of BACKUP_TABLES) tables[table] = await readTable(db, table);
  const document: BackupDocument = { version: 1, takenAt: new Date(now).toISOString(), tables };
  const text = JSON.stringify(document);
  const sha256 = await sha256Hex(text);
  const key = backupKey(now);
  await bucket.put(key, text, { customMetadata: { sha256 } });
  // Read back before anything older is deleted: a backup that cannot be read is not one.
  const stored = await bucket.get(key);
  if (!stored || (await sha256Hex(await stored.text())) !== sha256) throw new BackupError("the backup that was written does not read back the same");
  const pruned = await pruneBackups(bucket, now);
  return { key, rows: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])), bytes: new TextEncoder().encode(text).length, sha256, pruned };
}

/** Deletes backups older than the keep time. Returns how many. Never deletes anything outside the backup prefix. */
export async function pruneBackups(bucket: BackupBucket, now: number): Promise<number> {
  const oldest = dayOf(now - (BACKUP_KEEP_DAYS - 1) * DAY_MS);
  const expired: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, ...(cursor === undefined ? {} : { cursor }) });
    for (const { key } of page.objects) {
      const day = /^backups\/(\d{4}-\d{2}-\d{2})\.json(?:\.retry)?$/.exec(key)?.[1];
      // A name that is not a backup's, or the note beside one, is left alone.
      if (day !== undefined && day < oldest) expired.push(key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  if (expired.length > 0) await bucket.delete(expired);
  return expired.length;
}

/**
 * Loads a backup into a database whose tables exist and are empty. Refuses a
 * backup whose content does not match its recorded hash, and refuses to write
 * into a table that already holds rows.
 */
export async function restore(db: BackupDatabase, bucket: BackupBucket, key: string): Promise<Record<string, number>> {
  const stored = await bucket.get(key);
  if (!stored) throw new BackupError(`there is no backup named "${key}"`);
  const text = await stored.text();
  const recorded = stored.customMetadata?.sha256;
  if (recorded === undefined) throw new BackupError("the backup has no recorded hash");
  if ((await sha256Hex(text)) !== recorded) throw new BackupError("the backup does not match its recorded hash");
  let document: BackupDocument;
  try {
    document = JSON.parse(text) as BackupDocument;
  } catch {
    throw new BackupError("the backup is not valid JSON");
  }
  if (document.version !== 1 || typeof document.tables !== "object" || document.tables === null) throw new BackupError("the backup is not in a known format");

  const restored: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    const rows = document.tables[table];
    if (!Array.isArray(rows)) throw new BackupError(`the backup has no table "${table}"`);
    const present = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().all<{ n: number }>()).results[0]?.n ?? 0;
    if (present > 0) throw new BackupError(`the table "${table}" is not empty`);
  }
  for (const table of BACKUP_TABLES) {
    const rows = document.tables[table] ?? [];
    for (const row of rows) {
      const columns = Object.keys(row);
      // Column names come from a file. Only plain names are put into SQL.
      if (columns.length === 0 || !columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column))) throw new BackupError(`a row of "${table}" has a column name that is not usable`);
      const places = columns.map((_, index) => `?${index + 1}`).join(", ");
      await db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${places})`).bind(...columns.map((column) => row[column])).run();
    }
    restored[table] = rows.length;
  }
  return restored;
}
