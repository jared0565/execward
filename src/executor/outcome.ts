/**
 * Turns what a Dynamic Worker reported into an `ExecutionOutcome` (task 1.2.1).
 *
 * The report was produced inside the sandbox, by code that ran beside the
 * script, so it is untrusted input: every field is checked, and anything of
 * the wrong shape is a sandbox fault.
 */
import type { ExecutionFailureKind, ExecutionLimits, ExecutionOutcome } from "../executor";

export const MAX_LOG_LINES = 200;
/** The largest declaration of critical figures read from a sandbox's report. */
export const MAX_DECLARATION_CHARS = 1_000_000;
/** Stands in for a declaration that could not be read. The cross-check refuses it. */
export const UNREADABLE_DECLARATION = "unreadable";
export const TRUNCATED_LOGS_NOTICE = "[further log output was dropped]";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The first `maxBytes` bytes of `text`, cut on a character boundary. */
export function cutToBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // A cut through the middle of a character decodes to the replacement character; drop it.
  const replacement = String.fromCharCode(0xfffd);
  let text2 = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes));
  while (text2.endsWith(replacement)) text2 = text2.slice(0, -1);
  return text2;
}

/** Keeps log output within the same budget as the result, so logs cannot be used to return bulk data. */
export function capLogs(logs: unknown, maxBytes: number): string[] {
  if (!Array.isArray(logs)) return [];
  const kept: string[] = [];
  let used = 0;
  for (const entry of logs) {
    if (typeof entry !== "string") continue;
    const size = byteLength(entry);
    if (kept.length >= MAX_LOG_LINES || used + size > maxBytes) {
      kept.push(TRUNCATED_LOGS_NOTICE);
      return kept;
    }
    kept.push(entry);
    used += size;
  }
  return kept;
}

/** `detail` is for the audit log. The message is what a caller may see, so it holds no text from outside. */
export function fault(message: string, logs: readonly string[] = [], detail?: string): ExecutionOutcome {
  return { status: "failed", failure: { kind: "sandbox_fault", message, ...(detail === undefined ? {} : { detail: detail.slice(0, 2_000) }) }, logs };
}

export function failed(kind: ExecutionFailureKind, message: string, logs: readonly string[] = [], line?: number): ExecutionOutcome {
  return {
    status: "failed",
    failure: { kind, message, ...(line === undefined ? {} : { line }) },
    logs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function interpretReport(report: unknown, limits: ExecutionLimits): ExecutionOutcome {
  if (!isRecord(report)) return fault("the sandbox returned no report");
  // The runner lists the globals it could not hide. Any at all, or no list, and the allowed
  // set is not what was promised: the run is a fault, whatever else the report says.
  if (!Array.isArray(report.globalsLeft) || report.globalsLeft.length > 0) {
    const names = Array.isArray(report.globalsLeft) ? report.globalsLeft.filter((name): name is string => typeof name === "string").slice(0, 20).join(", ") : "no list was given";
    return fault("the sandbox could not hide every global it should, so the script was not run", [], names);
  }
  const logs = capLogs(report.logs, limits.maxResultBytes);
  const passed =
    typeof report.assertionsPassed === "number" && Number.isInteger(report.assertionsPassed) && report.assertionsPassed >= 0
      ? { assertionsPassed: report.assertionsPassed }
      : {};

  if (report.status === "failed") {
    const kind = report.kind === "assertion_failed" ? "assertion_failed" : "script_error";
    let message = typeof report.message === "string" ? cutToBytes(report.message, 2_000) : "the script failed";
    // FR-40: say what the condition actually was, not only that it was false.
    if (kind === "assertion_failed" && typeof report.value === "string") {
      message = `${message} (the condition was ${cutToBytes(report.value, 200)})`;
    }
    const line = typeof report.line === "number" && Number.isInteger(report.line) && report.line > 0 ? report.line : undefined;
    return { ...failed(kind, message, logs, line), ...passed };
  }

  if (report.status !== "completed" || typeof report.resultJson !== "string") {
    return fault("the sandbox returned a report in an unknown shape", logs);
  }

  // FR-43: what the script declared as critical. Passed on as it came, for the core to check.
  // If it cannot even be read, that is passed on too: a declaration is never dropped in silence.
  let critical: { critical?: unknown } = {};
  if (report.criticalJson !== undefined) {
    critical = { critical: UNREADABLE_DECLARATION };
    if (typeof report.criticalJson === "string" && report.criticalJson.length <= MAX_DECLARATION_CHARS) {
      try {
        critical = { critical: JSON.parse(report.criticalJson) as unknown };
      } catch {
        // Left as unreadable.
      }
    }
  }

  if (byteLength(report.resultJson) > limits.maxResultBytes) {
    // FR-5: an oversized final value is cut, and says so. Task 1.2.4 shapes the notice the model sees.
    return { status: "completed", result: cutToBytes(report.resultJson, limits.maxResultBytes), logs, truncated: true, ...passed, ...critical };
  }
  try {
    return { status: "completed", result: JSON.parse(report.resultJson) as unknown, logs, truncated: false, ...passed, ...critical };
  } catch {
    return fault("the sandbox returned a result that is not JSON", logs);
  }
}

/**
 * The platform's two messages for an isolate it ended at a limit, whole. Matching the
 * words anywhere in a message would let some other failure that carried them be taken
 * for a limit, and a limit is an ordinary result where a fault is a security matter.
 */
const PLATFORM_CPU_LIMIT = /^Worker exceeded CPU time limit\.?$/;
const PLATFORM_MEMORY_LIMIT = /^Worker exceeded memory limit\.?$/;

/** Which platform limit a failed call's message reports, if it is exactly one of them. */
export function platformLimit(message: string): "cpu" | "memory" | undefined {
  if (PLATFORM_CPU_LIMIT.test(message)) return "cpu";
  if (PLATFORM_MEMORY_LIMIT.test(message)) return "memory";
  return undefined;
}
