/**
 * The numeric limits ExecWard enforces (task 0.1.12). These are the starting
 * defaults; each can be lowered per project in the policy table, never raised
 * above `PLATFORM_CEILINGS`. The reason for every value is in
 * docs/decisions/0.1.12-numeric-limits.md.
 */
import type { ExecutionLimits } from "./executor";

/** What Cloudflare enforces whatever we configure (docs/research/0.1.2-dynamic-workers.md). */
export const PLATFORM_CEILINGS = {
  /** Memory per isolate. Fixed by the platform; ExecWard cannot set it lower. */
  memoryBytes: 128 * 1024 * 1024,
  /** Largest CPU limit a Workers Paid account can configure per invocation. */
  cpuMs: 300_000,
  /** Distinct Dynamic Workers with in-flight requests per Worker request. */
  concurrentDynamicWorkers: 4,
} as const;

/** Limits on one run of one script (FR-4, FR-5). */
export const RUN_LIMITS = {
  cpuMs: 1_000,
  wallClockMs: 30_000,
  maxHostCalls: 100,
  maxResultBytes: 32 * 1024,
} as const satisfies ExecutionLimits;

/** Limits applied before a script runs (FR-33). */
export const SCRIPT_LIMITS = {
  /** A script larger than this is refused with `static_check_failed`. */
  maxScriptBytes: 64 * 1024,
} as const;

/** Limits on single calls and their results at the broker (FR-29, FR-35). */
export const CALL_LIMITS = {
  /** Arguments above this size are flagged as unusually large (FR-29). */
  largeArgumentBytes: 16 * 1024,
  /** A single tool result above this size is rejected (FR-35). */
  maxToolResultBytes: 1024 * 1024,
} as const;

/** Quotas per project (FR-27). */
export const PROJECT_QUOTAS = {
  runsPerMinute: 10,
  concurrentRuns: 2,
  runsPerDay: 500,
  upstreamCallsPerDay: 10_000,
} as const;

/** Circuit breaker inside one run (FR-27). */
export const CIRCUIT_BREAKER = {
  /** Upstream errors in a row before the run is ended. */
  consecutiveUpstreamErrors: 5,
  /** Policy denials in one run before it is ended. The first already escalates (FR-41). */
  policyDenials: 3,
} as const;

/** Self-correction (FR-41). */
export const SELF_CORRECTION = {
  /** Failed runs in a row the model may follow with another try. The next failure closes the task. */
  maxRetries: 2,
} as const;

/** How long the audit log keeps things (FR-21, flag 5). */
export const RETENTION = {
  /** Scripts, arguments and other full text. */
  fullTextDays: 7,
  /** The entry itself, and the full text of any run that included a security event. */
  recordDays: 90,
} as const;

/** Spend caps on the platform itself. Model spend is capped separately (FR-51). */
export const SPEND_CAPS = {
  /** Cloudflare's price for one Dynamic Worker beyond the included 1,000 a month. */
  usdPerRun: 0.002,
  usdPerDay: 1,
  usdPerMonth: 20,
} as const;
