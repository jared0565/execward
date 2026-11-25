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
import { ERROR_CODES, type ErrorCode, type ExecWardError } from "../contracts/errors";
import { DATA_CLASSES, type DataClass } from "../contracts/policy";
import type { ExecutionFailureKind, ExecutionLimits, Executor, SandboxHost } from "../executor";
import { RUN_LIMITS, SCRIPT_LIMITS } from "../limits";
import { checkScript } from "../static-check/check";
import type { AuditLog } from "../audit/log";
import type { MeterFactory, MeterRecord, RunMeter } from "../meter/meter";
import { metricFor, type MetricsSink } from "../metrics/metrics";
import type { AttemptGate } from "./attempts";
import { releaseGate, type GateCheck } from "./release-gate";
import { crossCheck, type CheckedFigure } from "../verify/cross-check";
import type { ReviewInput, ReviewVerdict } from "../verify/reviewer";

/**
 * The script's way out for one run. A host that refuses a call on security
 * grounds reports it through `securityError`; the run then ends with that
 * error whatever the script did next (FR-41).
 */
export type RunHost = SandboxHost & {
  securityError?(): ExecWardError | undefined;
  /**
   * What the run has read: the highest data class and the number of records.
   * A host that cannot say is treated as having read the highest class.
   */
  provenance?(): { readonly dataClass: DataClass | undefined; readonly records: number };
};

/** One call a script made, as the audit log records it (FR-8). */
export interface CallRecord {
  readonly path: string;
  readonly args: unknown;
  /** `ok`, or the error code the call ended with. */
  outcome: string;
  /** Size of the result as JSON; 0 when there was none. */
  resultBytes: number;
}

/** Arguments larger than this are logged as a size, not in full. */
const MAX_LOGGED_ARGUMENT_BYTES = 4 * 1024;

export interface CodeToolDeps {
  readonly executor: Executor;
  /**
   * The audit log. Required: there is no switch that turns it off (FR-8). A
   * run that cannot be recorded does not start, and a result that cannot be
   * recorded is not returned.
   */
  readonly audit: AuditLog;
  /** Builds the script's way out for one run: the broker. */
  readonly hostFor: (run: { readonly runId: string; readonly project: string }) => RunHost;
  readonly newRunId: () => string;
  /** Milliseconds; injected so tests are exact. */
  readonly now: () => number;
  readonly limits?: ExecutionLimits;
  /**
   * The highest data class a project's runs may return to the model (FR-36).
   * Left out, it is `public`: the most cautious answer. Task 1.3.7 sets it per project.
   */
  readonly allowedDataClass?: (project: string) => DataClass;
  /**
   * Self-correction for the task this run belongs to (FR-41): counts failed
   * runs in a row and refuses the next one once the task is closed.
   */
  readonly attempts?: AttemptGate;
  /** Token metering (FR-19). Separate from the audit log, and never able to fail a run. */
  readonly meter?: MeterFactory;
  /** Per-run metrics for monitoring. Separate from the audit log, and never able to fail a run. */
  readonly metrics?: MetricsSink;
  /** The owner's switches (FR-16, FR-27): why a run for this project may not start, if it may not. */
  readonly control?: (project: string) => Promise<ExecWardError | undefined>;
  /**
   * What this run may handle, and through which provider route its reply
   * leaves (FR-38). Takes the place of `allowedDataClass` when given. If it
   * throws, the run is refused.
   */
  readonly exposure?: (project: string) => Promise<{ readonly allowed: DataClass; readonly provider: string }>;
  /**
   * Run admission: per-project quotas and spend caps (FR-27). A run is admitted
   * before it starts and released when it ends, however it ends.
   */
  readonly admission?: {
    admit(run: { readonly runId: string; readonly project: string; readonly wallClockMs: number }): Promise<ExecWardError | undefined>;
    release(run: { readonly runId: string; readonly project: string }): Promise<void>;
  };
  /**
   * Told when a critical figure a script declared does not match the host's own
   * working (FR-43). It puts the matter in the owner's queue and returns the
   * item's ID. Left out, or failing, the result is still withheld: as an error.
   */
  readonly onCrossCheckDisagreement?: (held: {
    readonly runId: string;
    readonly project: string;
    readonly report: RunReport;
    readonly figures: readonly CheckedFigure[];
  }) => Promise<string>;
  /**
   * The independent reviewer (FR-48). Asked only about a result that passed every
   * fixed check and came with criteria. Left out, a released result is `unreviewed`.
   */
  readonly review?: (input: ReviewInput) => Promise<ReviewVerdict>;
}

/** What a model is told when a result is held. Fixed words: nothing a script wrote. */
export const HELD_NOTICE =
  "A critical figure in this result did not match an independent recomputation, so the result is held for the owner to review. Do not run the script again to get round this; tell the user the result is waiting for the owner.";

/** What is returned in place of content that was withheld (FR-36). */
export function maskNotice(read: DataClass, allowed: DataClass): { masked: true; notice: string } {
  return {
    masked: true,
    notice:
      `Withheld: this run read ${read} data, and this project may only return ${allowed} data. ` +
      "The script ran; see the report for what it called. To get a result, read only data the project is allowed to return.",
  };
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
  const wrap = (part: unknown): { notice: string; partial: unknown } => ({
    notice:
      `The script's final value was larger than the ${maxBytes}-byte limit and was cut. ` +
      "The text under `partial` is the start of it and is not complete JSON. " +
      "Return less: a count, a summary, or only the fields and items you need.",
    partial: part,
  });
  if (typeof partial !== "string") return wrap(partial);
  // The cut text is sent as a JSON string, where every quote, backslash and line break takes
  // more bytes than it did. Text that was cut to the limit can be over it again once sent, so
  // it is cut until what is sent fits. (Found with real models, 2026-11-23: a cut list of
  // records came out 8% over, and the release gate withheld it as a fault.)
  if (byteLength(wrap(partial)) <= maxBytes) return wrap(partial);
  // The longest start of the text that fits, found by halving.
  let fits = 0;
  let tooLong = partial.length;
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (byteLength(wrap(partial.slice(0, middle))) <= maxBytes) fits = middle;
    else tooLong = middle;
  }
  // Not half of a two-part character.
  const last = partial.charCodeAt(fits - 1);
  if (last >= 0xd800 && last <= 0xdbff) fits -= 1;
  return wrap(partial.slice(0, fits));
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
}

function countingHost(host: SandboxHost, callsByTool: Record<string, number>, journal: CallRecord[], runMeter?: RunMeter): SandboxHost {
  return {
    async callTool(path, args) {
      // Counted when asked, not when answered: a refused or failed call is still a call.
      callsByTool[path] = (callsByTool[path] ?? 0) + 1;
      const size = byteLength(args);
      const entry: CallRecord = {
        path,
        args: size > MAX_LOGGED_ARGUMENT_BYTES ? `[${size} bytes of arguments, not logged in full]` : args,
        outcome: "pending",
        resultBytes: 0,
      };
      journal.push(entry);
      try {
        const result = await host.callTool(path, args);
        entry.outcome = "ok";
        runMeter?.toolResult(path, result);
        entry.resultBytes = byteLength(result);
        return result;
      } catch (error) {
        // Host errors start with their code, for example "policy_denied: ...".
        const code = /^([a-z_]+):/.exec(error instanceof Error ? error.message : "")?.[1];
        entry.outcome = code ?? "error";
        throw error;
      }
    },
    close() {
      return host.close?.();
    },
    async search(query) {
      const found = await host.search(query);
      runMeter?.discovery("search", found);
      return found;
    },
    async describe(path) {
      const docs = await host.describe(path);
      runMeter?.discovery("describe", docs);
      return docs;
    },
  };
}

/** The sentence FR-17 asks for. Only read-only tools exist, so the list is always empty for now. */
export function sideEffectsMade(sideEffects: readonly { readonly tool: string; readonly summary: string }[]): string {
  if (sideEffects.length === 0) return "No side-effecting calls had been made.";
  return `Side-effecting calls already made: ${sideEffects.map((effect) => `${effect.tool} (${effect.summary})`).join("; ")}.`;
}

/** Codes that end a run. The run's own error already reports them. */
const RUN_ENDING_CODES: ReadonlySet<string> = new Set(["policy_denied", "quota_exceeded", "circuit_open", "definition_changed", "code_mode_off"]);

/** Most failed calls one report lists. */
export const MAX_REPORTED_CALL_ERRORS = 20;

/** Shown in place of a tool path that might carry withheld data. */
export const UNNAMED_CALL = "(a call that did not succeed)";

/**
 * Failed calls a script survived, for the report (FR-39). A script that
 * catches an error and carries on must not be able to hide that it happened.
 * Only the code and the tool are given: the error's own words may hold data.
 */
function callErrors(journal: readonly CallRecord[], shownPath: (path: string) => string): ExecWardError[] {
  const failed = journal.filter((entry) => entry.outcome !== "ok" && entry.outcome !== "pending" && !RUN_ENDING_CODES.has(entry.outcome));
  const listed: ExecWardError[] = failed.slice(0, MAX_REPORTED_CALL_ERRORS).map((entry) => ({
    code: Object.hasOwn(ERROR_CODES, entry.outcome) ? (entry.outcome as ErrorCode) : "upstream_error",
    message: `a call to ${shownPath(entry.path)} failed`,
  }));
  if (failed.length > MAX_REPORTED_CALL_ERRORS) {
    listed.push({ code: "upstream_error", message: `${failed.length - MAX_REPORTED_CALL_ERRORS} more failed calls are not listed` });
  }
  return listed;
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
  const output = await runOnce(rawInput, deps);
  // Every ending is counted, whichever line of `runOnce` returned it.
  await deps.attempts?.settle(output);
  if (deps.metrics) {
    const project = typeof rawInput === "object" && rawInput !== null && typeof (rawInput as { project?: unknown }).project === "string" ? (rawInput as { project: string }).project.slice(0, 128) : "unknown";
    try {
      await deps.metrics.export(metricFor(output, project, meterRecords.get(output)));
    } catch {
      // A metric that cannot be sent is lost. The run is not.
    }
  }
  return output;
}

/** The meter's record for a reply, when metering was on, so the metric can carry it. */
const meterRecords = new WeakMap<CodeToolOutput, MeterRecord>();

async function runOnce(rawInput: unknown, deps: CodeToolDeps): Promise<CodeToolOutput> {
  const started = deps.now();
  const runId = deps.newRunId();
  const limits = deps.limits ?? RUN_LIMITS;
  // No prototype: a script chooses these names, and "toString" or "constructor" on an ordinary
  // object would be found on its prototype and counted as something that is not a number.
  const callsByTool: Record<string, number> = Object.create(null) as Record<string, number>;
  let scriptHash = EMPTY_SHA256;

  let assertionsPassed = 0;
  let recordsRead = 0;
  // A script chooses the path of a call that fails, so when content is being
  // withheld such a path could carry it out. Only paths that worked are named.
  let hidePaths = false;
  const shownPath = (path: string): string => (!hidePaths || journal.some((entry) => entry.path === path && entry.outcome === "ok") ? path : UNNAMED_CALL);
  const shownCalls = (): Record<string, number> => {
    const shown: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [path, count] of Object.entries(callsByTool)) {
      const name = shownPath(path);
      shown[name] = (shown[name] ?? 0) + count;
    }
    return shown;
  };
  let runHost: RunHost | undefined;
  let runMeter: RunMeter | undefined;
  // Set by the release gate. Until then nothing has been checked, so nothing is claimed.
  let verification: RunReport["verification"] = "not_applicable";
  let gateChecks: readonly GateCheck[] | undefined;
  let criteria: RunReport["criteria"];
  let crossChecks: RunReport["crossChecks"];
  const report = (errors: readonly ExecWardError[], assertionFailed = false): RunReport => ({
    runId,
    scriptHash,
    callsByTool: shownCalls(),
    recordsRead,
    recordsWritten: 0,
    // The error that ended the run, then any failed calls the script survived.
    errors: [...errors, ...callErrors(journal, shownPath)],
    retries: deps.attempts?.retries() ?? 0,
    // A run ends at its first failed assertion, so `failed` is 0 or 1.
    assertions: { passed: assertionsPassed, failed: assertionFailed ? 1 : 0 },
    sideEffects: [],
    ...(criteria ? { criteria } : {}),
    ...(crossChecks ? { crossChecks } : {}),
    verification,
    // On Cloudflare the clock stands still while a script computes, so this is the time spent
    // waiting on calls and is too low for a script that mostly computes. It decides nothing.
    // Measured 2026-11-24: docs/decisions/2.1.8-live-checks.md.
    durationMs: Math.max(0, deps.now() - started),
  });
  const journal: CallRecord[] = [];
  const isSecurity = (error: ExecWardError | undefined): boolean => error !== undefined && ERROR_CODES[error.code].security;

  /** A refusal is recorded too. If even that cannot be written, the refusal still stands. */
  const refused = async (error: ExecWardError, script: unknown, project: unknown): Promise<CodeToolOutput> => {
    const reply: CodeToolOutput = { status: "refused", error, report: report([error]) };
    await deps.audit
      .record({
        kind: "run_refused",
        security: isSecurity(error),
        runId,
        project: typeof project === "string" ? project.slice(0, 128) : "unknown",
        body: { scriptHash, script: typeof script === "string" ? script.slice(0, SCRIPT_LIMITS.maxScriptBytes) : null, error, security: isSecurity(error), report: reply.report },
      })
      .catch(() => undefined);
    return reply;
  };
  const rawProject = typeof rawInput === "object" && rawInput !== null ? (rawInput as { project?: unknown }).project : undefined;

  // The static check runs on any script text, before the rest of the input is
  // judged, so an oversized or hostile script is always reported as that.
  const rawScript = typeof rawInput === "object" && rawInput !== null ? (rawInput as { script?: unknown }).script : undefined;
  if (typeof rawScript === "string") {
    const check = await checkScript(rawScript);
    scriptHash = check.scriptHash;
    if (!check.ok) return refused(check.error, rawScript, rawProject);
  }

  const input = codeToolInputSchema.safeParse(rawInput);
  if (!input.success) {
    return refused(
      { code: "schema_invalid", message: `the input does not match the code tool's contract: ${describeIssues(input.error.issues)}` },
      rawScript,
      rawProject,
    );
  }

  // FR-47: the criteria are on record before work starts. Through this route they are the
  // model's own words, so they are marked as that and never treated as the user's.
  if (input.data.criteria !== undefined && input.data.criteria.length > 0) criteria = { source: "model_supplied", items: [...input.data.criteria] };

  // FR-41: a task that was closed, by a security failure or by using up its retries, runs nothing more.
  const closed = deps.attempts?.blocked();
  if (closed) return refused(closed, input.data.script, input.data.project);

  // FR-16, FR-27: with Code Mode off, the kill switch set or the project paused, nothing starts.
  if (deps.control) {
    let stopped: ExecWardError | undefined;
    try {
      stopped = await deps.control(input.data.project);
    } catch {
      stopped = { code: "code_mode_off", message: "the control state is unavailable, so nothing is run" };
    }
    if (stopped) return refused(stopped, input.data.script, input.data.project);
  }

  const admitted = { runId, project: input.data.project };
  if (deps.admission) {
    let over: ExecWardError | undefined;
    try {
      over = await deps.admission.admit({ ...admitted, wallClockMs: limits.wallClockMs });
    } catch {
      // Fail closed: no answer from the quota service is a refusal.
      over = { code: "quota_exceeded", message: "the quota service is unavailable" };
    }
    if (over) return refused(over, input.data.script, input.data.project);
  }

  // FR-38: settle what the run may handle before anything runs.
  let exposed: { readonly allowed: DataClass; readonly provider: string } | undefined;
  if (deps.exposure) {
    try {
      exposed = await deps.exposure(input.data.project);
    } catch {
      await deps.admission?.release(admitted).catch(() => undefined);
      return refused({ code: "policy_denied", message: "the project's data class could not be read, so the run was not started" }, input.data.script, input.data.project);
    }
  }

  // FR-8: the run is on record before it starts. No record, no run.
  try {
    await deps.audit.record({
      kind: "run_started",
      runId,
      project: input.data.project,
      body: {
        scriptHash,
        script: input.data.script,
        executor: deps.executor.name,
        limits,
        // FR-38: the provider is recorded for every run. "unknown" when nothing established it.
        provider: exposed?.provider ?? "unknown",
        ...(exposed ? { allowedDataClass: exposed.allowed } : {}),
        ...(input.data.intent === undefined ? {} : { intent: input.data.intent }),
        ...(criteria ? { criteria } : {}),
      },
    });
  } catch {
    await deps.admission?.release(admitted).catch(() => undefined);
    const error: ExecWardError = { code: "policy_denied", message: "the audit log is unavailable, so the run was not started" };
    return { status: "refused", error, report: report([error]) };
  }

  /** Records how the run ended. False when it could not be written. */
  const finish = async (reply: CodeToolOutput, extra: Record<string, unknown> = {}): Promise<boolean> => {
    const error = reply.status === "error" || reply.status === "refused" ? reply.error : undefined;
    try {
      await deps.audit.record({
        kind: "run_finished",
        security: isSecurity(error),
        runId,
        project: input.data.project,
        body: {
          scriptHash,
          status: reply.status,
          ...(error ? { error } : {}),
          security: isSecurity(error),
          calls: journal,
          resultBytes: reply.status === "completed" ? byteLength(reply.result) : 0,
          durationMs: reply.report.durationMs,
          // The report as returned, so the log and the reply cannot disagree (FR-39).
          report: reply.report,
          ...extra,
        },
      });
      return true;
    } catch {
      return false;
    }
  };
  const unrecorded = (): CodeToolOutput => {
    const error: ExecWardError = { code: "policy_denied", message: "the audit log is unavailable, so the result is withheld" };
    return { status: "error", error, report: report([error]) };
  };

  let output: CodeToolOutput;
  // Kept for the audit log only: what a fault said, and a count withheld from a masked reply.
  let faultDetail: string | undefined;
  let assertionsWithheld: number | undefined;
  let checkedFigures: readonly CheckedFigure[] | undefined;
  let reviewed: ReviewVerdict | undefined;
  try {
    const host = deps.hostFor({ runId, project: input.data.project });
    runMeter = deps.meter?.start({ runId, project: input.data.project });
    runHost = host;
    const outcome = await deps.executor.execute({
      runId,
      script: input.data.script,
      limits,
      host: countingHost(host, callsByTool, journal, runMeter),
    });
    assertionsPassed = outcome.assertionsPassed ?? 0;
    if (outcome.status === "failed") faultDetail = outcome.failure.detail;

    // FR-36. What the run read decides what may be returned. A host that
    // cannot say what was read is treated as having read the highest class.
    const provenance = host.provenance?.() ?? { dataClass: DATA_CLASSES[DATA_CLASSES.length - 1], records: 0 };
    recordsRead = provenance.records;
    const allowed = exposed?.allowed ?? deps.allowedDataClass?.(input.data.project) ?? "public";
    const read = provenance.dataClass;
    const masked = read !== undefined && DATA_CLASSES.indexOf(read) > DATA_CLASSES.indexOf(allowed);
    hidePaths = masked;
    if (masked) {
      // A script chooses how many assertions pass, so the count could carry what it read.
      assertionsWithheld = assertionsPassed;
      assertionsPassed = 0;
    }
    const hygiene = { untrusted: true as const, ...(read === undefined ? {} : { dataClass: read }), ...(masked ? { masked: true } : {}) };
    // Logs are the script's to write, so they are withheld with the result.
    const logs = outcome.logs.length > 0 && !masked ? { logs: [...outcome.logs] } : {};
    const securityError = host.securityError?.();
    if (securityError) {
      // A refused call ends the run. The script's own result or error is not
      // returned: a script must not learn more by catching the refusal.
      // FR-17: a run ended by a switch says which side-effecting calls it had already made.
      const ending: ExecWardError = securityError.code === "code_mode_off" ? { ...securityError, message: `${securityError.message}. ${sideEffectsMade([])}` } : securityError;
      output = { status: "error", error: ending, report: report([ending]) };
    } else if (outcome.status === "completed" && outcome.critical !== undefined) {
      // FR-43: the script declared critical figures. Each is worked out again here, from the
      // numbers it gave, before anything is handed over.
      const check = crossCheck(outcome.critical);
      if (!check.ok) {
        // A declaration that cannot be checked is never treated as an agreement. The model can fix it.
        const error: ExecWardError = {
          code: "script_error",
          message: masked && read !== undefined ? `a critical figure could not be checked; the detail is withheld because the run read ${read} data` : `a critical figure could not be checked: ${check.problem}`,
        };
        output = { status: "error", error, ...logs, ...hygiene, report: report([error]) };
      } else {
        checkedFigures = check.figures;
        const disagreed = check.figures.filter((figure) => !figure.agrees).length;
        // A script chooses how many figures it declares, so the counts are withheld with the content.
        if (!masked) crossChecks = { agreed: check.figures.length - disagreed, disagreed };
        if (disagreed === 0) {
          output = {
            status: "completed",
            result: masked && read !== undefined ? maskNotice(read, allowed) : outcome.truncated ? truncationNotice(outcome.result, limits.maxResultBytes) : outcome.result,
            truncated: masked ? false : outcome.truncated,
            ...logs,
            ...hygiene,
            report: report([]),
          };
        } else {
          // Disagreement: the result is held, and the owner is asked. Nothing the script wrote goes back.
          let escalationId: string | undefined;
          try {
            escalationId = await deps.onCrossCheckDisagreement?.({ runId, project: input.data.project, report: report([]), figures: check.figures });
          } catch {
            escalationId = undefined;
          }
          if (typeof escalationId === "string" && escalationId !== "") {
            output = { status: "paused", escalation_id: escalationId, report: report([]), notices: [HELD_NOTICE] };
          } else {
            // No queue to hold it in. It is withheld all the same.
            const error: ExecWardError = { code: "assertion_failed", message: "a critical figure did not match an independent recomputation, so the result is withheld" };
            output = { status: "error", error, report: report([error]) };
          }
        }
      }
    } else if (outcome.status === "completed") {
      output = {
        status: "completed",
        result:
          masked && read !== undefined
            ? maskNotice(read, allowed)
            : outcome.truncated
              ? truncationNotice(outcome.result, limits.maxResultBytes)
              : outcome.result,
        truncated: masked ? false : outcome.truncated,
        ...logs,
        ...hygiene,
        report: report([]),
      };
    } else {
      // A script chooses what it throws and asserts, so those words are withheld too.
      const scriptWords = outcome.failure.kind === "script_error" || outcome.failure.kind === "assertion_failed";
      const error: ExecWardError = {
        code: FAILURE_CODES[outcome.failure.kind],
        message:
          masked && scriptWords && read !== undefined
            ? `the script failed; its message is withheld because the run read ${read} data`
            : outcome.failure.kind === "assertion_failed"
              ? withCondition(outcome.failure.message, input.data.script, outcome.failure.line)
              : outcome.failure.message,
        ...(outcome.failure.line === undefined ? {} : { line: outcome.failure.line }),
      };
      output = { status: "error", error, ...logs, ...hygiene, report: report([error], outcome.failure.kind === "assertion_failed") };
    }

    // FR-47: the release gate checks exactly what is about to be handed over.
    const verdict = releaseGate({
      ...(output.status === "completed" ? { result: output.result } : {}),
      ...(output.status === "completed" || output.status === "error" ? { logs: output.logs ?? [] } : {}),
      ...(output.status === "error" ? { errorMessage: output.error.message } : {}),
      read,
      allowed,
      masked,
      maxResultBytes: limits.maxResultBytes,
    });
    gateChecks = verdict.checks;
    if (verdict.failure) {
      // A failed check cannot be overruled. The reply is replaced, not repaired.
      verification = "failed";
      output = { status: "error", error: verdict.failure, report: report([verdict.failure], output.report.assertions.failed > 0) };
    } else if (output.status === "completed") {
      // Released after the fixed checks. Only a reviewer's pass makes it `passed` (FR-48).
      verification = "unreviewed";
      // The reviewer judges against criteria, so without them there is nothing to ask. A withheld
      // result is not sent to it either: there is nothing in it to judge.
      if (deps.review && criteria && !masked) {
        try {
          reviewed = await deps.review({
            runId,
            project: input.data.project,
            ...(input.data.intent === undefined ? {} : { intent: input.data.intent }),
            criteria: criteria.items,
            output: output.result,
            report: output.report,
            dataClass: read ?? "public",
            deterministicCheckPassed: true,
            tier: 0,
          });
        } catch {
          // A reviewer that breaks is a missing reviewer: the result stays unreviewed.
          reviewed = undefined;
        }
      }
      if (reviewed?.outcome === "blocked") {
        // The reviewer's own words are not passed on: only which criteria, by number.
        verification = "failed";
        const unmet = reviewed.unmet ?? [];
        const error: ExecWardError = {
          code: "review_blocked",
          message: `the independent reviewer found that the result does not meet ${unmet.length === 1 ? "criterion" : "criteria"} ${unmet.join(", ")}, so it is withheld`,
        };
        output = { status: "error", error, ...hygiene, report: report([error]) };
      } else {
        if (reviewed?.outcome === "passed") verification = "passed";
        output = { ...output, report: { ...output.report, verification } };
      }
    }
  } catch (cause) {
    // An executor must not throw; if one does, that is a sandbox fault. Nothing is run another way.
    // What was read before the fault still counts, and what may be shown is unknown, so paths are hidden.
    hidePaths = true;
    try {
      recordsRead = runHost?.provenance?.().records ?? 0;
    } catch {
      recordsRead = 0;
    }
    // What the executor said goes to the audit log. The caller gets fixed words.
    const error: ExecWardError = { code: "sandbox_fault", message: "the executor failed" };
    const reply: CodeToolOutput = { status: "error", error, report: report([error]) };
    return (await finish(reply, { faultDetail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_000) })) ? reply : unrecorded();
  } finally {
    await deps.admission?.release(admitted).catch(() => undefined);
  }

  // Never send a reply the contract does not describe.
  const checked = codeToolOutputSchema.safeParse(output);
  if (!checked.success) {
    const error: ExecWardError = { code: "sandbox_fault", message: "the run produced a reply that does not match the output contract" };
    const reply: CodeToolOutput = { status: "error", error, report: report([error]) };
    return (await finish(reply)) ? reply : unrecorded();
  }
  const hygieneFacts =
    output.status === "completed" || output.status === "error"
      ? { ...(output.dataClass === undefined ? {} : { dataClass: output.dataClass }), masked: output.masked === true }
      : {};
  // FR-19: the meter counts what was written and what is sent back. It changes neither.
  const metered = await runMeter?.finish({
    script: input.data.script,
    returned: output.status === "completed" ? output.result : output.status === "error" ? output.error.message : "",
  });
  if (metered) meterRecords.set(output, metered);
  // The outcome is on record before anyone is told it.
  const kept = {
    ...(faultDetail === undefined ? {} : { faultDetail }),
    ...(assertionsWithheld === undefined ? {} : { assertionsPassedWithheld: assertionsWithheld }),
    // Both values of every declared figure, for the owner's record. The reply carries only counts.
    ...(checkedFigures === undefined ? {} : { crossCheck: checkedFigures }),
    // The reviewer's verdict, why there was none, and what the call cost.
    ...(reviewed === undefined ? {} : { review: reviewed }),
  };
  return (await finish(output, { ...hygieneFacts, ...kept, ...(gateChecks ? { releaseGate: gateChecks } : {}) })) ? output : unrecorded();
}
