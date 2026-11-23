/**
 * Per-run metrics for the monitoring stack (task 1.9.3, NFR: observability).
 *
 * One record per run: how long it took, how it ended and whether that was a
 * security event, plus the token estimates when metering is on. Numbers and
 * fixed codes only. No script, no arguments, no result, no error text.
 *
 * Metrics are separate from the audit log and can never fail a run.
 */
import type { CodeToolOutput } from "../contracts/code-tool";
import { ERROR_CODES, type ErrorCode } from "../contracts/errors";
import type { MeterRecord } from "../meter/meter";

export interface RunMetric {
  readonly runId: string;
  readonly project: string;
  readonly status: CodeToolOutput["status"];
  /** The code of the error that ended the run, when one did. */
  readonly errorCode?: ErrorCode;
  /** True when the run ended on a security code: the figure alerts are built on. */
  readonly securityEvent: boolean;
  readonly durationMs: number;
  readonly toolCalls: number;
  readonly failedCalls: number;
  readonly recordsRead: number;
  readonly retries: number;
  readonly verification: CodeToolOutput["report"]["verification"];
  /** Present only when metering is on. Estimates, as the meter labels them. */
  readonly tokens?: {
    readonly estimated: true;
    readonly script: number;
    readonly returned: number;
    readonly keptOut: number;
    readonly estimatedSaving: number;
  };
}

export interface MetricsSink {
  export(metric: RunMetric): Promise<void>;
}

export function memoryMetricsSink(): MetricsSink & { readonly metrics: RunMetric[] } {
  const metrics: RunMetric[] = [];
  return { metrics, export: async (metric) => void metrics.push(metric) };
}

export function metricFor(output: CodeToolOutput, project: string, metered?: MeterRecord): RunMetric {
  const error = output.status === "error" || output.status === "refused" ? output.error : undefined;
  const report = output.report;
  return {
    runId: report.runId,
    project,
    status: output.status,
    ...(error ? { errorCode: error.code } : {}),
    securityEvent: error !== undefined && ERROR_CODES[error.code].security,
    durationMs: report.durationMs,
    toolCalls: Object.values(report.callsByTool).reduce((sum, count) => sum + count, 0),
    // The first error is the one that ended the run, when the run ended in one.
    failedCalls: Math.max(0, report.errors.length - (error ? 1 : 0)),
    recordsRead: report.recordsRead,
    retries: report.retries,
    verification: report.verification,
    ...(metered
      ? { tokens: { estimated: true as const, script: metered.scriptTokens, returned: metered.returnedTokens, keptOut: metered.keptOutTokens, estimatedSaving: metered.estimatedSavingTokens } }
      : {}),
  };
}
