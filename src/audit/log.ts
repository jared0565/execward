/**
 * The audit log (tasks 1.4.1 and 1.4.2, FR-8, FR-28).
 *
 * Append-only and hash-chained. Each entry holds the hash of the entry before
 * it, so editing, removing or inserting an entry breaks every hash after it,
 * and `verifyChain` says where.
 *
 * The chain covers the hash of an entry's content, not the content. That is
 * deliberate: content must be deletable later (retention, task 1.4.4) without
 * breaking the chain, while any content still present can be checked.
 *
 * Only the host writes here. A script has no binding, no network and no
 * function that reaches this file.
 */
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
  /** The details, as redacted JSON. `null` once it has been expired or deleted. */
  readonly content: string | null;
  readonly contentHash: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditStore {
  /** The newest entry's position and hash, or `undefined` for an empty log. */
  last(): Promise<{ readonly seq: number; readonly hash: string } | undefined>;
  /** Adds an entry. False when another writer already took that position. */
  insert(entry: AuditEntry): Promise<boolean>;
  /** Every entry, oldest first. */
  all(): Promise<AuditEntry[]>;
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
  return sha256Hex(JSON.stringify([entry.seq, entry.at, entry.kind, entry.runId, entry.project, entry.contentHash, entry.prevHash]));
}

export interface AuditLog {
  /** Writes one event. Throws `AuditLogError` when it could not be written. */
  record(event: { readonly kind: string; readonly runId: string; readonly project: string; readonly body: unknown }): Promise<void>;
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

/** Checks a log from its first entry. Reports the first entry that does not fit. */
export async function verifyChain(entries: readonly AuditEntry[]): Promise<ChainCheck> {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) return { ok: false, seq: entry.seq, reason: `expected entry ${expectedSeq}: an entry is missing, added or out of order` };
    if (entry.prevHash !== prevHash) return { ok: false, seq: entry.seq, reason: "does not follow the entry before it" };
    if (entry.hash !== (await entryHash(entry))) return { ok: false, seq: entry.seq, reason: "its details do not match its hash" };
    if (entry.content !== null && entry.contentHash !== (await sha256Hex(entry.content))) {
      return { ok: false, seq: entry.seq, reason: "its content was changed" };
    }
    prevHash = entry.hash;
    expectedSeq++;
  }
  return { ok: true, entries: entries.length };
}

/** A log held in memory, for tests. `entries` is exposed so a test can tamper with it. */
export function memoryAuditStore(): AuditStore & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    last: async () => {
      const newest = entries[entries.length - 1];
      return newest ? { seq: newest.seq, hash: newest.hash } : undefined;
    },
    insert: async (entry) => {
      if (entries.some((existing) => existing.seq === entry.seq)) return false;
      entries.push(entry);
      return true;
    },
    all: async () => [...entries],
  };
}

/** The part of a D1 database the store uses. */
export interface AuditDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
    all<T>(): Promise<{ results: T[] }>;
  };
}

interface Row {
  seq: number;
  at: string;
  kind: string;
  run_id: string;
  project: string;
  content: string | null;
  content_hash: string;
  prev_hash: string;
  hash: string;
}

/** The log in D1 (table and append-only triggers in migrations/0002_audit_log.sql). */
export function d1AuditStore(db: AuditDatabase): AuditStore {
  return {
    async last() {
      const row = await db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT ?1").bind(1).first<{ seq: number; hash: string }>();
      return row ?? undefined;
    },
    async insert(entry) {
      try {
        await db
          .prepare("INSERT INTO audit_log (seq, at, kind, run_id, project, content, content_hash, prev_hash, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
          .bind(entry.seq, entry.at, entry.kind, entry.runId, entry.project, entry.content, entry.contentHash, entry.prevHash, entry.hash)
          .run();
        return true;
      } catch (cause) {
        // The position is the primary key: a clash means another writer got there first.
        if (/UNIQUE|PRIMARY KEY|constraint/i.test(cause instanceof Error ? cause.message : String(cause))) return false;
        throw cause;
      }
    },
    async all() {
      const { results } = await db.prepare("SELECT seq, at, kind, run_id, project, content, content_hash, prev_hash, hash FROM audit_log ORDER BY seq").all<Row>();
      return results.map((row) => ({
        seq: row.seq,
        at: row.at,
        kind: row.kind,
        runId: row.run_id,
        project: row.project,
        content: row.content,
        contentHash: row.content_hash,
        prevHash: row.prev_hash,
        hash: row.hash,
      }));
    },
  };
}
