/**
 * The net saving after verification, by kind of run (task 2.2.5, FR-51).
 *
 * Code Mode saves tokens by keeping tool results out of the model's context.
 * Verification spends tokens to check the result. What is left is the net
 * saving. A kind of run whose net saving is negative is flagged, so the owner
 * can narrow what is verified there or switch it off.
 *
 * Two different kinds of number meet here, and the report keeps them apart:
 * the saving is the token meter's estimate (a rough rule, not a tokenizer),
 * and the verification tokens are the provider's own count.
 *
 * A run does not say what type of task it is. The kind is read from what the
 * run did: it looked for tools, it called tools, or it did neither. That is a
 * stand-in for the eval's task types, not the same thing.
 */
import type { QuotaStore } from "../broker/quotas";
import type { MeterRecord } from "./meter";

export type RunKind = "exploratory" | "bounded_tool_heavy" | "no_tools";
export const RUN_KINDS: readonly RunKind[] = ["bounded_tool_heavy", "exploratory", "no_tools"];

/** A run that searched or described is exploratory; one that only called tools is bounded; the rest used no tool. */
export function runKindOf(record: Pick<MeterRecord, "keptOutTokens" | "discoveryTokens">): RunKind {
  if (record.discoveryTokens > 0) return "exploratory";
  if (record.keptOutTokens > 0) return "bounded_tool_heavy";
  return "no_tools";
}

/** The totals are kept for one period at a time, then start again, so an old loss does not hide a present saving. */
export const NET_SAVING_PERIOD_MS = 30 * 24 * 60 * 60_000;

export interface NetSavingEntry {
  readonly record: Pick<MeterRecord, "keptOutTokens" | "discoveryTokens" | "estimatedSavingTokens">;
  /** The verification call made for this run, if one was. The provider's counts. */
  readonly verification?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface NetSavingLine {
  readonly kind: RunKind;
  readonly runs: number;
  readonly verifiedRuns: number;
  /** The meter's estimate. May be negative. */
  readonly estimatedSavingTokens: number;
  /** The provider's count of what verification used. */
  readonly verificationTokens: number;
  readonly netSavingTokens: number;
  /** True when the net saving is below zero. */
  readonly flagged: boolean;
  /** What to consider, when flagged. */
  readonly advice?: string;
}

export interface NetSavingReport {
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly lines: readonly NetSavingLine[];
  /** Always true: the saving side of every line is an estimate. */
  readonly savingIsEstimated: true;
}

export interface NetSavingStore {
  /** Adds one run to its kind's totals. */
  add(entry: NetSavingEntry, now: number): Promise<void>;
  report(now: number): Promise<NetSavingReport>;
}

export const ADVICE = {
  verification: "Verification uses more tokens than Code Mode saves for this kind of run. Narrow what is verified here, or switch verification off for it.",
  codeMode: "Code Mode itself uses more tokens than it saves for this kind of run, before any verification. Consider direct calls for it.",
} as const;

export function netSavingLine(kind: RunKind, totals: { readonly runs: number; readonly verifiedRuns: number; readonly estimatedSavingTokens: number; readonly verificationTokens: number }): NetSavingLine {
  const netSavingTokens = totals.estimatedSavingTokens - totals.verificationTokens;
  const flagged = totals.runs > 0 && netSavingTokens < 0;
  return { kind, ...totals, netSavingTokens, flagged, ...(flagged ? { advice: totals.estimatedSavingTokens < 0 ? ADVICE.codeMode : ADVICE.verification } : {}) };
}

/** Kept in the quota counters, which every copy of the Worker shares and which are added to in one step. */
export function quotaNetSavingStore(quotas: QuotaStore): NetSavingStore {
  const key = (kind: RunKind, what: string): string => `net-saving:${kind}:${what}`;
  const whole = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0);
  return {
    async add(entry, now) {
      const kind = runKindOf(entry.record);
      await quotas.add(key(kind, "runs"), NET_SAVING_PERIOD_MS, 1, now);
      await quotas.add(key(kind, "saving"), NET_SAVING_PERIOD_MS, whole(entry.record.estimatedSavingTokens), now);
      if (entry.verification) {
        await quotas.add(key(kind, "verified"), NET_SAVING_PERIOD_MS, 1, now);
        await quotas.add(key(kind, "verification"), NET_SAVING_PERIOD_MS, Math.max(0, whole(entry.verification.inputTokens) + whole(entry.verification.outputTokens)), now);
      }
    },
    async report(now) {
      const read = (kind: RunKind, what: string): Promise<number> => quotas.add(key(kind, what), NET_SAVING_PERIOD_MS, 0, now);
      const lines: NetSavingLine[] = [];
      for (const kind of RUN_KINDS) {
        lines.push(netSavingLine(kind, { runs: await read(kind, "runs"), verifiedRuns: await read(kind, "verified"), estimatedSavingTokens: await read(kind, "saving"), verificationTokens: await read(kind, "verification") }));
      }
      const periodStart = Math.floor(now / NET_SAVING_PERIOD_MS) * NET_SAVING_PERIOD_MS;
      return { periodStart, periodEnd: periodStart + NET_SAVING_PERIOD_MS, lines, savingIsEstimated: true };
    },
  };
}
