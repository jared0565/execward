/**
 * An export of the audit log, with the chain check run on it (incident
 * runbook step 3; FR-21, FR-46).
 *
 * During an incident the log is the evidence. This turns the rows of the
 * database into a copy that can be kept somewhere else, and says whether the
 * copy is whole: every entry present, in order, and unchanged.
 */
import { verifyChain, type AuditEntry, type ChainAnchor, type ChainCheck } from "./log";

/** A row of `audit_log` as the database returns it. */
export interface AuditRow {
  readonly seq: unknown;
  readonly at: unknown;
  readonly kind: unknown;
  readonly run_id: unknown;
  readonly project: unknown;
  readonly security: unknown;
  readonly content: unknown;
  readonly content_hash: unknown;
  readonly prev_hash: unknown;
  readonly hash: unknown;
}

export interface AuditExport {
  readonly exportedAt: string;
  /** Where the copy came from, for example "production". */
  readonly source: string;
  readonly anchor: ChainAnchor | null;
  readonly check: ChainCheck;
  /** How many entries of each kind. Counts only: the entries themselves follow. */
  readonly kinds: Readonly<Record<string, number>>;
  readonly first: string | null;
  readonly last: string | null;
  readonly entries: readonly AuditEntry[];
}

function text(value: unknown, name: string, seq: unknown): string {
  if (typeof value !== "string") throw new Error(`entry ${String(seq)}: "${name}" is not text`);
  return value;
}

/** Rows as entries. A row that is not the shape of an entry stops the export: a damaged copy is not evidence. */
export function rowsToEntries(rows: readonly AuditRow[]): AuditEntry[] {
  return rows.map((row) => {
    if (typeof row.seq !== "number" || !Number.isInteger(row.seq)) throw new Error(`an entry has no whole-number position: ${JSON.stringify(row.seq)}`);
    if (row.content !== null && typeof row.content !== "string") throw new Error(`entry ${row.seq}: "content" is neither text nor empty`);
    return {
      seq: row.seq,
      at: text(row.at, "at", row.seq),
      kind: text(row.kind, "kind", row.seq),
      runId: text(row.run_id, "run_id", row.seq),
      project: text(row.project, "project", row.seq),
      security: row.security === 1 || row.security === true,
      content: row.content,
      contentHash: text(row.content_hash, "content_hash", row.seq),
      prevHash: text(row.prev_hash, "prev_hash", row.seq),
      hash: text(row.hash, "hash", row.seq),
    };
  });
}

export async function auditExport(rows: readonly AuditRow[], anchor: ChainAnchor | undefined, source: string, now: Date = new Date()): Promise<AuditExport> {
  const entries = rowsToEntries(rows).sort((a, b) => a.seq - b.seq);
  const kinds: Record<string, number> = {};
  for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  return {
    exportedAt: now.toISOString(),
    source,
    anchor: anchor ?? null,
    check: await verifyChain(entries, anchor),
    kinds,
    first: entries[0]?.at ?? null,
    last: entries.at(-1)?.at ?? null,
    entries,
  };
}

/** Checks a saved export again, from its own entries. For a copy that has been somewhere else. */
export async function recheck(saved: Pick<AuditExport, "entries" | "anchor">): Promise<ChainCheck> {
  return verifyChain(saved.entries, saved.anchor ?? undefined);
}
