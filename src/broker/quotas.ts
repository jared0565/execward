/**
 * Quotas, spend caps and run admission (task 1.3.8, FR-27).
 *
 * Counting is behind `QuotaStore`, so the rules here do not care where the
 * numbers live. `memoryQuotaStore` is complete and is what the tests use. A
 * durable store shared by every Worker instance is still owed; until it
 * exists these limits hold only within one process.
 *
 * Fail closed: if the store cannot answer, the run or call is refused.
 */
import type { ExecWardError } from "../contracts/errors";
import { PROJECT_QUOTAS, SPEND_CAPS } from "../limits";

export interface QuotaStore {
  /**
   * Adds `amount` to the counter for `key` in the current window and returns
   * the new total. Windows are fixed: every `windowMs` from the epoch.
   */
  add(key: string, windowMs: number, amount: number, now: number): Promise<number>;
  /** Takes one of `limit` slots for `key`. False when all are held. A slot lapses after `ttlMs`. */
  acquire(key: string, holder: string, limit: number, ttlMs: number, now: number): Promise<boolean>;
  release(key: string, holder: string): Promise<void>;
}

export function memoryQuotaStore(): QuotaStore {
  const counters = new Map<string, number>();
  const slots = new Map<string, Map<string, number>>();
  return {
    async add(key, windowMs, amount, now) {
      const id = `${key}@${windowMs}:${Math.floor(now / windowMs)}`;
      const total = (counters.get(id) ?? 0) + amount;
      counters.set(id, total);
      return total;
    },
    async acquire(key, holder, limit, ttlMs, now) {
      const held = slots.get(key) ?? new Map<string, number>();
      slots.set(key, held);
      // A run that died without releasing its slot must not hold it for ever.
      for (const [other, expires] of held) if (expires <= now) held.delete(other);
      if (held.size >= limit) return false;
      held.set(holder, now + ttlMs);
      return true;
    },
    async release(key, holder) {
      slots.get(key)?.delete(holder);
    },
  };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A fixed 30-day window stands in for a calendar month. */
const MONTH = 30 * DAY;

export interface ProjectQuotas {
  readonly runsPerMinute: number;
  readonly concurrentRuns: number;
  readonly runsPerDay: number;
  readonly upstreamCallsPerDay: number;
}

export interface SpendCaps {
  readonly usdPerRun: number;
  readonly usdPerDay: number;
  readonly usdPerMonth: number;
}

export interface QuotaContext {
  readonly store: QuotaStore;
  readonly project: string;
  readonly now: () => number;
  readonly quotas?: ProjectQuotas;
  readonly spend?: SpendCaps;
}

function refusal(reason: string): ExecWardError {
  return { code: "quota_exceeded", message: reason };
}

/** Money is counted in millionths of a dollar, so the totals stay whole numbers. */
function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/**
 * Decides whether a run may start, and counts it. Returns the refusal, or
 * `undefined` when the run is admitted and holds a slot it must release.
 *
 * A refused attempt still counts against the per-minute and per-day limits: a
 * caller that keeps hammering stays refused.
 */
export async function admitRun(context: QuotaContext, runId: string, wallClockMs: number): Promise<ExecWardError | undefined> {
  const quotas = context.quotas ?? PROJECT_QUOTAS;
  const spend = context.spend ?? SPEND_CAPS;
  const { store, project } = context;
  const now = context.now();
  try {
    if ((await store.add(`runs:${project}`, MINUTE, 1, now)) > quotas.runsPerMinute) {
      return refusal(`the project's limit of ${quotas.runsPerMinute} runs a minute was reached`);
    }
    if ((await store.add(`runs:${project}`, DAY, 1, now)) > quotas.runsPerDay) {
      return refusal(`the project's limit of ${quotas.runsPerDay} runs a day was reached`);
    }
    // Each run is charged its full price up front. The platform bills per sandbox started.
    const price = micros(spend.usdPerRun);
    if ((await store.add(`spend:${project}`, DAY, price, now)) > micros(spend.usdPerDay)) {
      return refusal(`the project's spend cap of $${spend.usdPerDay} a day was reached`);
    }
    if ((await store.add(`spend:${project}`, MONTH, price, now)) > micros(spend.usdPerMonth)) {
      return refusal(`the project's spend cap of $${spend.usdPerMonth} a month was reached`);
    }
    // Last, so a run refused above never holds a slot. The slot outlives the run's time limit by a margin.
    if (!(await store.acquire(`running:${project}`, runId, quotas.concurrentRuns, wallClockMs + MINUTE, now))) {
      return refusal(`the project's limit of ${quotas.concurrentRuns} runs at once was reached`);
    }
    return undefined;
  } catch {
    return refusal("the quota service is unavailable");
  }
}

export async function releaseRun(context: QuotaContext, runId: string): Promise<void> {
  try {
    await context.store.release(`running:${context.project}`, runId);
  } catch {
    // The slot lapses on its own. Nothing a caller can do with this failure.
  }
}

/**
 * Counts one upstream call against the project's and the tool's daily limits.
 * Returns the reason for refusing it, or `undefined`.
 */
export async function countCall(context: QuotaContext, path: string, toolCallsPerDay: number | undefined): Promise<string | undefined> {
  const quotas = context.quotas ?? PROJECT_QUOTAS;
  const now = context.now();
  try {
    if ((await context.store.add(`calls:${context.project}`, DAY, 1, now)) > quotas.upstreamCallsPerDay) {
      return `the project's limit of ${quotas.upstreamCallsPerDay} upstream calls a day was reached`;
    }
    if (toolCallsPerDay !== undefined && (await context.store.add(`calls:${context.project}:${path}`, DAY, 1, now)) > toolCallsPerDay) {
      return `the tool's limit of ${toolCallsPerDay} calls a day was reached`;
    }
    return undefined;
  } catch {
    return "the quota service is unavailable";
  }
}
