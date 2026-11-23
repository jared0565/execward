/**
 * The audit log (tasks 1.4.1, 1.4.2 and 1.4.4; FR-8, FR-28, FR-21).
 *
 * Append-only and hash-chained. Each entry holds the hash of the entry before
 * it, so editing, removing or inserting an entry breaks every hash after it,
 * and `verifyChain` says where.
 *
 * The chain covers the hash of an entry's content, not the content. That is
 * deliberate: content is removed when it expires or when a project's logs are
 * deleted on request, and the chain must still verify afterwards, while any
 * content still present can be checked.
 *
 * Old entries are removed whole, oldest first. The number and hash of the
 * newest removed entry are kept as the "anchor": the point the log now starts
 * from.
 *
 * Only the host writes here. A script has no binding, no network and no
 * function that reaches this file.
 */
import { RETENTION } from "../limits";
import { redact } from "./redact";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntry {
  /** Position in the log, from 1, with no gaps. */
  readonly seq: number;
  /** When it was written, as an ISO timestamp. */
  readonly at: string;
  readonly kind: string;
  readonly runId: string;
  readonly project: string;
  /** A security event. The full text of its whole run is kept for the longer period. */
  readonly security: boolean;
  /** The details, as redacted JSON. `null` once it has been expired or erased. */
  readonly content: string | null;
  readonly contentHash: string;
  readonly prevHash: string;
  readonly hash: string;
}

/** Where a log starts: the entry just before its first one. */
export interface ChainAnchor {
  readonly seq: number;
  readonly hash: string;
}

export interface AuditStore {
  /** The newest entry's position and hash; the anchor when no entries are left; `undefined` for a log never written. */
  last(): Promise<ChainAnchor | undefined>;
  /** Adds an entry. False when another writer already took that position. */
  insert(entry: AuditEntry): Promise<boolean>;
  /** Every entry still held, oldest first. */
  all(): Promise<AuditEntry[]>;
  /** Set once old entries have been removed. */
  anchor(): Promise<ChainAnchor | undefined>;
  /**
   * Removes the content of entries written before `before`, except those whose
   * run includes a security event. Returns how many were changed.
   */
  expireContent(before: string): Promise<number>;
  /** Removes whole entries written before `before`, oldest first, and moves the anchor. */
  removeBefore(before: string): Promise<number>;
  /** Removes the content of every entry of one project. */
  eraseProject(project: string): Promise<number>;
}

export class AuditLogError extends Error {
  override readonly name = "AuditLogError";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON never contains a raw control character, so a logged value cannot forge a new line or drive a terminal. */
function safeJson(value: unknown): string {
  let out = "";
  for (const char of JSON.stringify(value) ?? "null") {
    const code = char.charCodeAt(0);
    out += code === 0x7f || (code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? `${String.fromCharCode(92)}u${code.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}

/** The hash of an entry. A list written as JSON, so no field can run into the next. */
export function entryHash(entry: Omit<AuditEntry, "hash" | "content">): Promise<string> {
  return sha256Hex(JSON.stringify([entry.seq, entry.at, entry.kind, entry.runId, entry.project, entry.security, entry.contentHash, entry.prevHash]));
}

export interface AuditEvent {
  readonly kind: string;
  readonly runId: string;
  readonly project: string;
  readonly security?: boolean;
  readonly body: unknown;
}

export interface AuditLog {
  /** Writes one event. Throws `AuditLogError` when it could not be written. */
  record(event: AuditEvent): Promise<void>;
}

const MAX_ATTEMPTS = 5;

export function auditLog(store: AuditStore, now: () => number): AuditLog {
  return {
    async record(event) {
      // Redacted first: a secret must never reach the store, even for a moment (FR-21).
      const content = safeJson(redact(event.body));
      const contentHash = await sha256Hex(content);
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const last = await store.last();
          const unhashed = {
            seq: (last?.seq ?? 0) + 1,
            at: new Date(now()).toISOString(),
            kind: event.kind,
            runId: event.runId,
            project: event.project,
            security: event.security === true,
            contentHash,
            prevHash: last?.hash ?? GENESIS_HASH,
          };
          // Another writer may have taken this position in between; if so, read again and retry.
          if (await store.insert({ ...unhashed, content, hash: await entryHash(unhashed) })) return;
        }
      } catch (cause) {
        throw new AuditLogError(`the audit log could not be written: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      throw new AuditLogError("the audit log could not be written: too many writers at once");
    },
  };
}

export type ChainCheck = { readonly ok: true; readonly entries: number } | { readonly ok: false; readonly seq: number; readonly reason: string };

/**
 * Checks a log. It starts from the very beginning, or from `anchor` when old
 * entries have been removed. Reports the first entry that does not fit.
 */
export async function verifyChain(entries: readonly AuditEntry[], anchor?: ChainAnchor): Promise<ChainCheck> {
  let prevHash = anchor?.hash ?? GENESIS_HASH;
  let expectedSeq = (anchor?.seq ?? 0) + 1;
  for (const entry of entries) {
    // An entry at or before the anchor is one whose removal was interrupted; the next retention run takes it.
    if (anchor && entry.seq <= anchor.seq) continue;
    if (entry.seq !== expectedSeq) return { ok: false, seq: entry.seq, reason: `expected entry ${expectedSeq}: an entry is missing, added or out of order` };
    if (entry.prevHash !== prevHash) return { ok: false, seq: entry.seq, reason: "does not follow the entry before it" };
    if (entry.hash !== (await entryHash(entry))) return { ok: false, seq: entry.seq, reason: "its details do not match its hash" };
    if (entry.content !== null && entry.contentHash !== (await sha256Hex(entry.content))) {
      return { ok: false, seq: entry.seq, reason: "its content was changed" };
    }
    prevHash = entry.hash;
    expectedSeq++;
  }
  return { ok: true, entries: entries.filter((entry) => !anchor || entry.seq > anchor.seq).length };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  /** Entries whose full text was removed. */
  readonly contentExpired: number;
  /** Entries removed whole. */
  readonly entriesRemoved: number;
}

/**
 * Applies the retention periods (FR-21): full text for `fullTextDays`, the
 * entry itself for `recordDays`. The full text of a run that included a
 * security event is kept until its entries are removed.
 */
export async function applyRetention(store: AuditStore, now: number, periods: { fullTextDays: number; recordDays: number } = RETENTION): Promise<RetentionResult> {
  const entriesRemoved = await store.removeBefore(new Date(now - periods.recordDays * DAY_MS).toISOString());
  const contentExpired = await store.expireContent(new Date(now - periods.fullTextDays * DAY_MS).toISOString());
  return { contentExpired, entriesRemoved };
}

/**
 * Deletes a project's logs on request: the content of every one of its
 * entries is removed, and the deletion is itself recorded. The entries' bare
 * outline (number, time, kind, run and project names) stays until it ages
 * out, because removing entries from the middle would break the chain.
 */
export async function deleteProjectLogs(store: AuditStore, log: AuditLog, project: string): Promise<number> {
  const erased = await store.eraseProject(project);
  await log.record({ kind: "project_logs_deleted", runId: "none", project, body: { entriesErased: erased } });
  return erased;
}

/** A log held in memory, for tests. `entries` is exposed so a test can tamper with it. */
export function memoryAuditStore(): AuditStore & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  let anchor: ChainAnchor | undefined;
  const blank = (index: number): void => {
    const entry = entries[index];
    if (entry) entries[index] = { ...entry, content: null };
  };
  return {
    entries,
    last: async () => {
      const newest = entries[entries.length - 1];
      return newest ? { seq: newest.seq, hash: newest.hash } : anchor;
    },
    insert: async (entry) => {
      if (entries.some((existing) => existing.seq === entry.seq)) return false;
      entries.push(entry);
      return true;
    },
    all: async () => [...entries],
    anchor: async () => anchor,
    expireContent: async (before) => {
      const securityRuns = new Set(entries.filter((entry) => entry.security).map((entry) => entry.runId));
      let changed = 0;
      entries.forEach((entry, index) => {
        if (entry.content !== null && entry.at < before && !securityRuns.has(entry.runId)) {
          blank(index);
          changed++;
        }
      });
      return changed;
    },
    removeBefore: async (before) => {
      let removed = 0;
      while (entries[0] && entries[0].at < before) {
        const gone = entries.shift();
        if (gone) anchor = { seq: gone.seq, hash: gone.hash };
        removed++;
      }
      return removed;
    },
    eraseProject: async (project) => {
      let changed = 0;
      entries.forEach((entry, index) => {
        if (entry.project === project && entry.content !== null) {
          blank(index);
          changed++;
        }
      });
      return changed;
    },
  };
}

/** The part of a D1 database the store uses. */
export interface AuditDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<{ meta?: { changes?: number } }> };
    all<T>(): Promise<{ results: T[] }>;
  };
}

interface Row {
  seq: number;
  at: string;
  kind: string;
  run_id: string;
  project: string;
  security: number;
  content: string | null;
  content_hash: string;
  prev_hash: string;
  hash: string;
}

/** The log in D1 (tables and triggers in migrations/0002_audit_log.sql). */
export function d1AuditStore(db: AuditDatabase): AuditStore {
  const anchor = async (): Promise<ChainAnchor | undefined> =>
    (await db.prepare("SELECT seq, hash FROM audit_anchor WHERE id = ?1").bind(1).first<ChainAnchor>()) ?? undefined;
  return {
    anchor,
    async last() {
      const row = await db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT ?1").bind(1).first<ChainAnchor>();
      return row ?? (await anchor());
    },
    async insert(entry) {
      try {
        await db
          .prepare("INSERT INTO audit_log (seq, at, kind, run_id, project, security, content, content_hash, prev_hash, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
          .bind(entry.seq, entry.at, entry.kind, entry.runId, entry.project, entry.security ? 1 : 0, entry.content, entry.contentHash, entry.prevHash, entry.hash)
          .run();
        return true;
      } catch (cause) {
        // The position is the primary key: a clash means another writer got there first.
        if (/UNIQUE|PRIMARY KEY|constraint/i.test(cause instanceof Error ? cause.message : String(cause))) return false;
        throw cause;
      }
    },
    async all() {
      const { results } = await db.prepare("SELECT seq, at, kind, run_id, project, security, content, content_hash, prev_hash, hash FROM audit_log ORDER BY seq").all<Row>();
      return results.map((row) => ({
        seq: row.seq,
        at: row.at,
        kind: row.kind,
        runId: row.run_id,
        project: row.project,
        security: row.security === 1,
        content: row.content,
        contentHash: row.content_hash,
        prevHash: row.prev_hash,
        hash: row.hash,
      }));
    },
    async expireContent(before) {
      const done = await db
        .prepare("UPDATE audit_log SET content = NULL WHERE content IS NOT NULL AND at < ?1 AND run_id NOT IN (SELECT run_id FROM audit_log WHERE security = 1)")
        .bind(before)
        .run();
      return done.meta?.changes ?? 0;
    },
    async removeBefore(before) {
      // One at a time, oldest first: the database allows only the oldest entry to go.
      let removed = 0;
      for (;;) {
        const oldest = await db.prepare("SELECT seq, hash FROM audit_log WHERE at < ?1 AND seq = (SELECT MIN(seq) FROM audit_log)").bind(before).first<ChainAnchor>();
        if (!oldest) return removed;
        // The anchor moves first. If the delete then fails, the next run finds the same entry and repeats both.
        await db.prepare("INSERT INTO audit_anchor (id, seq, hash) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET seq = ?1, hash = ?2").bind(oldest.seq, oldest.hash).run();
        await db.prepare("DELETE FROM audit_log WHERE seq = ?1").bind(oldest.seq).run();
        removed++;
      }
    },
    async eraseProject(project) {
      const done = await db.prepare("UPDATE audit_log SET content = NULL WHERE content IS NOT NULL AND project = ?1").bind(project).run();
      return done.meta?.changes ?? 0;
    },
  };
}
