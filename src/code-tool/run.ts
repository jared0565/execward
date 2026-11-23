/**
 * The `code` tool (task 1.2.4): takes what a client sent, and returns one of
 * the four shapes in contract 2. This is the run path:
 *
 *   input contract  ->  static check (FR-33)  ->  executor  ->  output contract
 *
 * It holds no policy. Whether a tool call is allowed is the host's decision
 * (the broker, tasks 1.3.x); this file only counts the calls for the report.
 */
import { codeToolInputSchema, codeToolOutputSchema, type CodeToolOutput, type RunReport } from "../contracts/code-tool";
import type { ErrorCode, ExecWardError } from "../contracts/errors";
import type { ExecutionFailureKind, ExecutionLimits, Executor, SandboxHost } from "../executor";
import { RUN_LIMITS } from "../limits";
import { checkScript } from "../static-check/check";

/**
 * The script's way out for one run. A host that refuses a call on security
 * grounds reports it through `securityError`; the run then ends with that
 * error whatever the script did next (FR-41).
 */
export type RunHost = SandboxHost & { securityError?(): ExecWardError | undefined };

export interface CodeToolDeps {
  readonly executor: Executor;
  /** Builds the script's way out for one run: the broker. */
  readonly hostFor: (run: { readonly runId: string; readonly project: string }) => RunHost;
  readonly newRunId: () => string;
  /** Milliseconds; injected so tests are exact. */
  readonly now: () => number;
  readonly limits?: ExecutionLimits;
}

/** Each way a run can fail maps onto exactly one public error code (contract 5). */
const FAILURE_CODES: Readonly<Record<ExecutionFailureKind, ErrorCode>> = {
  script_error: "script_error",
  assertion_failed: "assertion_failed",
  timeout: "timeout",
  quota_exceeded: "quota_exceeded",
  sandbox_fault: "sandbox_fault",
};

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** What the model sees in place of a final value that was too large (FR-5). */
export function truncationNotice(partial: unknown, maxBytes: number): { notice: string; partial: unknown } {
  return {
    notice:
      `The script's final value was larger than the ${maxBytes}-byte limit and was cut. ` +
      "The text under `partial` is the start of it and is not complete JSON. " +
      "Return less: a count, a summary, or only the fields and items you need.",
    partial,
  };
}

function countingHost(host: SandboxHost, callsByTool: Record<string, number>): SandboxHost {
  return {
    callTool(path, args) {
      // Counted when asked, not when answered: a refused or failed call is still a call.
      callsByTool[path] = (callsByTool[path] ?? 0) + 1;
      return host.callTool(path, args);
    },
    search: (query) => host.search(query),
    describe: (path) => host.describe(path),
  };
}

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length === 0 ? "input" : issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");
}

/** Adds the text of the failing line, so the model sees which condition failed (FR-40). */
function withCondition(message: string, script: string, line: number | undefined): string {
  if (line === undefined) return message;
  const source = script.split("\n")[line - 1]?.trim();
  if (!source) return message;
  return `${message}; at line ${line}: ${source.length > 200 ? `${source.slice(0, 200)}...` : source}`;
}

export async function runCodeTool(rawInput: unknown, deps: CodeToolDeps): Promise<CodeToolOutput> {
  const started = deps.now();
  const runId = deps.newRunId();
  const limits = deps.limits ?? RUN_LIMITS;
  const callsByTool: Record<string, number> = {};
  let scriptHash = EMPTY_SHA256;

  let assertionsPassed = 0;
  const report = (errors: readonly ExecWardError[], assertionFailed = false): RunReport => ({
    runId,
    scriptHash,
    callsByTool: { ...callsByTool },
    recordsRead: 0,
    recordsWritten: 0,
    errors: [...errors],
    retries: 0,
    // A run ends at its first failed assertion, so `failed` is 0 or 1.
    assertions: { passed: assertionsPassed, failed: assertionFailed ? 1 : 0 },
    sideEffects: [],
    // No reviewer exists yet (Phase 2), so nothing is claimed.
    verification: "not_applicable",
    durationMs: Math.max(0, deps.now() - started),
  });
  const refused = (error: ExecWardError): CodeToolOutput => ({ status: "refused", error, report: report([error]) });

  // The static check runs on any script text, before the rest of the input is
  // judged, so an oversized or hostile script is always reported as that.
  const rawScript = typeof rawInput === "object" && rawInput !== null ? (rawInput as { script?: unknown }).script : undefined;
  if (typeof rawScript === "string") {
    const check = await checkScript(rawScript);
    scriptHash = check.scriptHash;
    if (!check.ok) return refused(check.error);
  }

  const input = codeToolInputSchema.safeParse(rawInput);
  if (!input.success) {
    return refused({ code: "schema_invalid", message: `the input does not match the code tool's contract: ${describeIssues(input.error.issues)}` });
  }

  let output: CodeToolOutput;
  try {
    const host = deps.hostFor({ runId, project: input.data.project });
    const outcome = await deps.executor.execute({
      runId,
      script: input.data.script,
      limits,
      host: countingHost(host, callsByTool),
    });
    const logs = outcome.logs.length > 0 ? { logs: [...outcome.logs] } : {};
    assertionsPassed = outcome.assertionsPassed ?? 0;
    const securityError = host.securityError?.();
    if (securityError) {
      // A refused call ends the run. The script's own result or error is not
      // returned: a script must not learn more by catching the refusal.
      output = { status: "error", error: securityError, report: report([securityError]) };
    } else if (outcome.status === "completed") {
      output = {
        status: "completed",
        result: outcome.truncated ? truncationNotice(outcome.result, limits.maxResultBytes) : outcome.result,
        truncated: outcome.truncated,
        ...logs,
        report: report([]),
      };
    } else {
      const error: ExecWardError = {
        code: FAILURE_CODES[outcome.failure.kind],
        message:
          outcome.failure.kind === "assertion_failed"
            ? withCondition(outcome.failure.message, input.data.script, outcome.failure.line)
            : outcome.failure.message,
        ...(outcome.failure.line === undefined ? {} : { line: outcome.failure.line }),
      };
      output = { status: "error", error, ...logs, report: report([error], outcome.failure.kind === "assertion_failed") };
    }
  } catch (cause) {
    // An executor must not throw; if one does, that is a sandbox fault. Nothing is run another way.
    const error: ExecWardError = { code: "sandbox_fault", message: `the executor failed: ${cause instanceof Error ? cause.message : String(cause)}` };
    return { status: "error", error, report: report([error]) };
  }

  // Never send a reply the contract does not describe.
  const checked = codeToolOutputSchema.safeParse(output);
  if (!checked.success) {
    const error: ExecWardError = { code: "sandbox_fault", message: "the run produced a reply that does not match the output contract" };
    return { status: "error", error, report: report([error]) };
  }
  return output;
}
