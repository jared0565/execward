/**
 * The stats report (task 2.3.1, FR-20): metered runs grouped by session,
 * project, client and model.
 *
 * Two kinds of figure are in it and they are kept apart. Estimated: the token
 * meter's saving, from a rough rule and not a tokenizer. Measured: what the
 * provider says verification used. There is no measured saving for a
 * production run: that comes only from eval runs, which compare a task done
 * both ways, and the report says so instead of showing a number.
 *
 * A row holds sizes, counts and labels. The labels (session, client, model)
 * are the client's own words: they name a line and decide nothing.
 */
import type { MeterRecord } from "./meter";
import { runKindOf, type RunKind } from "./net-saving";

export const UNKNOWN_LABEL = "unknown";
/** How far back the report looks. */
export const STATS_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** How long a row is kept. */
export const STATS_KEEP_MS = 90 * 24 * 60 * 60_000;
/** The most lines shown for one grouping; the busiest come first. */
export const STATS_MAX_GROUPS = 50;

export interface StatsRow {
  readonly runId: string;
  readonly at: number;
  readonly project: string;
  readonly session: string;
  readonly client: string;
  readonly model: string;
  readonly kind: RunKind;
  readonly estimatedSavingTokens: number;
  readonly verified: boolean;
  readonly verificationTokens: number;
}

const whole = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0);

/** One run's row, from its meter record and what verifying it used. */
export function statsRowOf(record: MeterRecord, at: number, verification?: { readonly inputTokens: number; readonly outputTokens: number }): StatsRow {
  const label = (name: string): string => record.labels?.[name] ?? UNKNOWN_LABEL;
  // A client that names no session is grouped by day instead: the server keeps no sessions of its own.
  const session = record.labels?.session ?? `day:${new Date(at).toISOString().slice(0, 10)}`;
  return {
    runId: record.runId,
    at,
    project: record.project,
    session,
    client: label("client"),
    model: label("model"),
    kind: runKindOf(record),
    estimatedSavingTokens: whole(record.estimatedSavingTokens),
    verified: verification !== undefined,
    verificationTokens: verification === undefined ? 0 : Math.max(0, whole(verification.inputTokens) + whole(verification.outputTokens)),
  };
}

export type StatsDimension = "session" | "project" | "client" | "model";
export const STATS_DIMENSIONS: readonly StatsDimension[] = ["session", "project", "client", "model"];

export interface StatsGroup {
  readonly key: string;
  readonly runs: number;
  /** The meter's figures. Never a count from a provider. */
  readonly estimated: { readonly savingTokens: number };
  /** The provider's figures. */
  readonly measured: { readonly verifiedRuns: number; readonly verificationTokens: number };
}

export interface StatsStore {
  /** Keeps one run's row. A second row for the same run is ignored. */
  write(row: StatsRow): Promise<void>;
  /** Rows at or after `since`, grouped one way, busiest first. */
  groups(dimension: StatsDimension, since: number): Promise<StatsGroup[]>;
  /** Removes rows older than `before`. */
  trim(before: number): Promise<void>;
}

export interface StatsReport {
  readonly from: number;
  readonly to: number;
  readonly by: Readonly<Record<StatsDimension, readonly StatsGroup[]>>;
  /** Always null: no production run has a measured saving. See `notes`. */
  readonly measuredSavingTokens: null;
  readonly notes: readonly string[];
}

export const STATS_NOTES: readonly string[] = [
  "Estimated saving is the token meter's figure, from a rough rule of one token per four bytes. It is not a provider's count.",
  "Measured figures are the provider's own counts of what verification used.",
  "No measured saving is shown: it exists only for eval runs, where the same task is done both ways.",
  "Session, client and model are what the client said about itself. A run that gave no client or model is under \"unknown\"; one that gave no session is grouped by day.",
];

export async function statsReport(store: Pick<StatsStore, "groups">, now: number): Promise<StatsReport> {
  const from = now - STATS_WINDOW_MS;
  const by = {} as Record<StatsDimension, StatsGroup[]>;
  for (const dimension of STATS_DIMENSIONS) by[dimension] = await store.groups(dimension, from);
  return { from, to: now, by, measuredSavingTokens: null, notes: STATS_NOTES };
}

export function memoryStatsStore(): StatsStore & { readonly rows: Map<string, StatsRow> } {
  const rows = new Map<string, StatsRow>();
  return {
    rows,
    async write(row) {
      if (!rows.has(row.runId)) rows.set(row.runId, row);
    },
    async groups(dimension, since) {
      const found = new Map<string, { runs: number; saving: number; verified: number; tokens: number }>();
      for (const row of rows.values()) {
        if (row.at < since) continue;
        const group = found.get(row[dimension]) ?? { runs: 0, saving: 0, verified: 0, tokens: 0 };
        found.set(row[dimension], { runs: group.runs + 1, saving: group.saving + row.estimatedSavingTokens, verified: group.verified + (row.verified ? 1 : 0), tokens: group.tokens + row.verificationTokens });
      }
      return [...found.entries()]
        .map(([key, group]) => ({ key, runs: group.runs, estimated: { savingTokens: group.saving }, measured: { verifiedRuns: group.verified, verificationTokens: group.tokens } }))
        .sort((a, b) => b.runs - a.runs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, STATS_MAX_GROUPS);
    },
    async trim(before) {
      for (const [id, row] of rows) if (row.at < before) rows.delete(id);
    },
  };
}
