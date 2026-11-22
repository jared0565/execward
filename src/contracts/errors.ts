/**
 * Contract 5: error codes. A fixed set. Each is marked retryable or not; security
 * codes are never retryable, so the model cannot probe its way around a control (FR-41).
 */
import { z } from "zod";

interface ErrorCodeSpec {
  /** May the model fix its script and try again (up to the retry limit)? */
  readonly retryable: boolean;
  /** Security failures end the run and escalate at once. */
  readonly security: boolean;
  readonly meaning: string;
}

export const ERROR_CODES = {
  script_error: {
    retryable: true,
    security: false,
    meaning: "The script threw or was not valid JavaScript.",
  },
  schema_invalid: {
    retryable: true,
    security: false,
    meaning: "A tool call's arguments or a tool's result did not match its schema.",
  },
  assertion_failed: {
    retryable: true,
    security: false,
    meaning: "An assert() in the script failed.",
  },
  timeout: {
    retryable: true,
    security: false,
    meaning: "The run reached its CPU or wall-clock limit.",
  },
  upstream_error: {
    retryable: true,
    security: false,
    meaning: "A wrapped tool returned an error the script did not catch.",
  },
  result_too_large: {
    retryable: true,
    security: false,
    meaning: "A tool result exceeded the size the broker accepts.",
  },
  code_mode_off: {
    retryable: false,
    security: false,
    meaning: "Code Mode was switched off before or during the run.",
  },
  sandbox_fault: {
    retryable: false,
    security: false,
    meaning: "The sandbox itself failed. Nothing is run outside it.",
  },
  policy_denied: {
    retryable: false,
    security: true,
    meaning: "The broker refused a call under the policy table.",
  },
  static_check_failed: {
    retryable: false,
    security: true,
    meaning: "The script failed the pre-execution checks, including the secret scan.",
  },
  definition_changed: {
    retryable: false,
    security: true,
    meaning: "A tool's definition no longer matches its pinned hash.",
  },
  quota_exceeded: {
    retryable: false,
    security: true,
    meaning: "A quota, spend cap or per-run call limit was reached.",
  },
  circuit_open: {
    retryable: false,
    security: true,
    meaning: "The circuit breaker ended the run after repeated errors or denials.",
  },
  injection_suspected: {
    retryable: false,
    security: true,
    meaning: "Tool output or arguments carried a prompt-injection signal.",
  },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const errorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const errorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string(),
  /** Line in the script, when known (FR-7). */
  line: z.number().int().positive().optional(),
});

export type ExecWardError = z.infer<typeof errorSchema>;

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_CODES[code].retryable;
}
