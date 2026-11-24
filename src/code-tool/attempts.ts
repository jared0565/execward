/**
 * Self-correction (task 1.7.3, FR-41).
 *
 * When a run fails for a reason the model can fix, the error goes back to the
 * model and it may try again: at most `maxRetries` times in a row. A security
 * failure is never retried, so a model cannot probe its way around a control.
 *
 * One gate covers one task: one request from the user, however many times the
 * model calls the `code` tool for it. The in-app adapter makes a gate per
 * task. Through the MCP adapter the server cannot see where one task ends,
 * so the count is kept per caller and project: see ./stored-attempts.ts.
 */
import type { CodeToolOutput } from "../contracts/code-tool";
import { ERROR_CODES, type ExecWardError } from "../contracts/errors";
import { SELF_CORRECTION } from "../limits";

export type EscalationReason = "security" | "retries_exhausted" | "not_retryable";

export interface Escalation {
  readonly reason: EscalationReason;
  /** The failure that caused it. */
  readonly error: ExecWardError;
  readonly runId: string;
}

export interface AttemptGate {
  /** Why the next run must not start, or `undefined` when it may. */
  blocked(): ExecWardError | undefined;
  /** Failed runs in a row before the next one: the report's `retries`. */
  retries(): number;
  /**
   * Told how every run ended, including ones this gate refused. Resolves once
   * any escalation it caused has been dealt with, so that a project is paused
   * before the reply that caused the pause is handed over.
   */
  settle(output: CodeToolOutput): Promise<void>;
  /** Retries the model still has. 0 once the task is closed. */
  remaining(): number;
}

export interface AttemptGateOptions {
  readonly maxRetries?: number;
  /** Called once, when the task is closed and must go to a person. */
  readonly onEscalate?: (escalation: Escalation) => unknown;
}

export function attemptGate(options: AttemptGateOptions = {}): AttemptGate {
  const maxRetries = options.maxRetries ?? SELF_CORRECTION.maxRetries;
  let failuresInARow = 0;
  let closed: ExecWardError | undefined;

  async function close(reason: EscalationReason, error: ExecWardError, runId: string, refusal: ExecWardError): Promise<void> {
    closed = refusal;
    try {
      await options.onEscalate?.({ reason, error, runId });
    } catch {
      // The task is closed whether or not anyone could be told.
    }
  }

  return {
    blocked: () => closed,
    retries: () => failuresInARow,
    remaining: () => (closed ? 0 : Math.max(0, maxRetries - failuresInARow)),
    async settle(output) {
      // A refusal this gate caused is not a new failure.
      if (closed) return;
      if (output.status === "completed" || output.status === "paused") {
        failuresInARow = 0;
        return;
      }
      const error = output.error;
      const spec = ERROR_CODES[error.code];
      if (spec.security) {
        // The refusal keeps the original code, so the reason stays visible.
        return close("security", error, output.report.runId, { code: error.code, message: "this task was ended by a security failure and cannot be retried; it has been escalated" });
      }
      if (!spec.retryable) {
        return close("not_retryable", error, output.report.runId, { code: error.code, message: "this task ended with a failure that a retry cannot fix; it has been escalated" });
      }
      failuresInARow += 1;
      if (failuresInARow > maxRetries) {
        await close("retries_exhausted", error, output.report.runId, {
          code: "quota_exceeded",
          message: `the retry limit for this task was reached (${maxRetries} retries); it has been escalated`,
        });
      }
    },
  };
}
