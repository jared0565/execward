/**
 * The `code` tool with every control in place (task 1.3.7).
 *
 * The parts are built so each can be tested alone, which means several of
 * them accept being left out. This is the one place that puts them together,
 * and here nothing is optional: policy table, project classes, provider
 * route, quotas, audit log. A route that serves the `code` tool must go
 * through `codeToolService` and nothing else.
 */
import { auditLog, type AuditStore } from "./audit/log";
import { brokerHost, type ToolDefinition, type Upstream } from "./broker/broker";
import { exposureFor, type Exposure, type Gate, type ProjectRecord, type ProjectStore, CLIENT_DATA_GATE, CLIENT_OPTED_OUT_MESSAGE } from "./broker/exposure";
import type { PolicyStore } from "./broker/policy-store";
import { admitRun, releaseRun, type QuotaStore } from "./broker/quotas";
import type { AttemptGate } from "./code-tool/attempts";
import { callGate, runGate, type ControlStore } from "./console/control";
import type { MeterFactory } from "./meter/meter";
import type { MetricsSink } from "./metrics/metrics";
import { runCodeTool, type CodeToolDeps } from "./code-tool/run";
import type { CodeToolOutput } from "./contracts/code-tool";
import type { ExecWardError } from "./contracts/errors";
import type { PolicyRecord } from "./contracts/policy";
import type { ExecutionLimits, Executor } from "./executor";

export interface CodeToolServiceDeps {
  readonly executor: Executor;
  readonly policy: PolicyStore;
  readonly projects: ProjectStore;
  /**
   * Refuse a run that names a project with no record, before anything is counted or
   * looked up for it. Set where the project's name comes from the calling model (the MCP
   * server): otherwise a model could make up names, each with a retry limit, a pause
   * state and a spend cap of its own. (Second review, finding F1; the owner's decision
   * of 2026-11-26.) When `false`, a project with no record is `public`, as FR-32 says.
   * Required, so that letting unknown projects run is a choice someone made and not an
   * omission (model-review finding `eafe3706f800`).
   */
  readonly requireKnownProject: boolean;
  readonly quotas: QuotaStore;
  readonly audit: AuditStore;
  readonly upstream: Upstream;
  readonly definitionFor: (record: PolicyRecord) => Promise<ToolDefinition | undefined>;
  /** Typed docs for `describe()`. Both this and `definitionFor` come from the registry. */
  readonly docsFor: (path: string) => Promise<{ readonly typing: string } | undefined>;
  /** Token metering. Required, so that "off" is a choice someone made and not an omission. */
  readonly meter: MeterFactory;
  /** Where per-run metrics go. */
  readonly metrics: MetricsSink;
  /** The owner's switches: Code Mode, the kill switch, paused projects, blocked tools. */
  readonly control: ControlStore;
  readonly now: () => number;
  readonly newRunId: () => string;
  /**
   * Puts a cross-check disagreement in the owner's queue and returns the item's ID (FR-43).
   * Without it a disagreeing result is still withheld, as an error.
   */
  readonly onCrossCheckDisagreement?: CodeToolDeps["onCrossCheckDisagreement"];
  /** The independent reviewer (FR-48). Without it a released result is `unreviewed`. */
  readonly review?: CodeToolDeps["review"];
  /** Keeps the net saving after verification (task 2.2.5). */
  readonly netSaving?: CodeToolDeps["netSaving"];
  /** Only tests pass this. Production uses `CLIENT_DATA_GATE`. */
  readonly gate?: Gate;
  /** Only the adversarial suite passes this, to set the caps a case then tries to pass. Production uses `RUN_LIMITS`. */
  readonly limits?: ExecutionLimits;
}

/**
 * How long, inside one run, a reading of the switches or of a tool's policy is used
 * again before the database is asked once more.
 *
 * Reading both on every tool call cost about 40 ms a call, which put any script with
 * more than a few calls over the latency budget (task 1.9.4). The project owner chose
 * this on 2026-11-23: a kill, a pause or a policy change stops a script that is already
 * running within this time, not at its very next call. A new run always reads afresh.
 */
export const RUN_RECHECK_MS = 250;

/** `read`, asked again only when the last answer is older than `RUN_RECHECK_MS`. A failed read is never kept. */
function reused<T>(read: () => Promise<T>, now: () => number): () => Promise<T> {
  let last: { readonly at: number; readonly value: Promise<T> } | undefined;
  return () => {
    const at = now();
    if (last !== undefined && at - last.at < RUN_RECHECK_MS) return last.value;
    const value = read();
    const mine = { at, value };
    last = mine;
    value.catch(() => {
      if (last === mine) last = undefined;
    });
    return value;
  };
}

export interface CallerContext {
  /**
   * How the calling client reaches its model provider: a key of
   * `PROVIDER_ROUTES`. Established by sign-in, never taken from the request
   * body. Anything unrecognised counts as the unknown route.
   */
  readonly providerRoute: unknown;
  /**
   * The retry count of the task this call belongs to (FR-41). The adapter
   * makes one per task with `attemptGate()` and passes the same one each time.
   */
  readonly attempts: AttemptGate;
}

export type CodeToolService = (rawInput: unknown, caller: CallerContext) => Promise<CodeToolOutput>;

export function codeToolService(deps: CodeToolServiceDeps): CodeToolService {
  const audit = auditLog(deps.audit, deps.now);
  return async (rawInput, caller) => {
    // The project's record is read once per call and that one reading settles everything
    // about it: whether it exists, what its client has asked for, and what it may handle.
    const projectReads = new Map<string, Promise<ProjectRecord | undefined>>();
    const projects: ProjectStore = {
      get(project) {
        let read = projectReads.get(project);
        if (!read) {
          read = deps.projects.get(project);
          projectReads.set(project, read);
        }
        return read;
      },
    };
    // Worked out once per run and shared, so the broker and the reply use the same answer.
    const exposures = new Map<string, Promise<Exposure>>();
    const exposure = (project: string): Promise<Exposure> => {
      let found = exposures.get(project);
      if (!found) {
        found = exposureFor(projects, project, caller.providerRoute, deps.gate ?? CLIENT_DATA_GATE);
        exposures.set(project, found);
      }
      return found;
    };
    const switches = runGate(deps.control);
    // The owner's switches first, then the client's own choice. Either one stops the run before it starts.
    const mayStart = async (project: string): Promise<ExecWardError | undefined> => {
      const stopped = await switches(project);
      if (stopped) return stopped;
      let record: ProjectRecord | undefined;
      try {
        record = await projects.get(project);
      } catch {
        // Not knowing what the client asked for is treated as a refusal.
        return { code: "policy_denied", message: "the project's data class could not be read, so the run was not started" };
      }
      // The client's "off" is a switch like the owner's own, so it has a switch's code. As `policy_denied`
      // it counted as a security failure: each call on such a project closed it to the caller, raised an
      // urgent item, paused the project and emailed the owner. (The owner's decision of 2026-11-27.)
      return record?.clientChoice?.aiUse === "off" ? { code: "code_mode_off", message: CLIENT_OPTED_OUT_MESSAGE } : undefined;
    };
    const quotaContext = (project: string) => ({ store: deps.quotas, project, now: deps.now });

    return runCodeTool(rawInput, {
      executor: deps.executor,
      audit,
      now: deps.now,
      newRunId: deps.newRunId,
      attempts: caller.attempts,
      meter: deps.meter,
      metrics: deps.metrics,
      ...(deps.limits ? { limits: deps.limits } : {}),
      ...(deps.onCrossCheckDisagreement ? { onCrossCheckDisagreement: deps.onCrossCheckDisagreement } : {}),
      ...(deps.review ? { review: deps.review } : {}),
      ...(deps.netSaving ? { netSaving: deps.netSaving } : {}),
      control: mayStart,
      ...(deps.requireKnownProject ? { projectKnown: async (project: string) => (await projects.get(project)) !== undefined } : {}),
      exposure,
      admission: {
        admit: (run) => admitRun(quotaContext(run.project), run.runId, run.wallClockMs),
        release: (run) => releaseRun(quotaContext(run.project), run.runId),
      },
      hostFor: (run) => {
        // One run's own short memory of the switches and of each tool's policy.
        const control: ControlStore = { read: reused(() => deps.control.read(), deps.now), write: (next, expected) => deps.control.write(next, expected) };
        const records = new Map<string, () => Promise<PolicyRecord | undefined>>();
        const policy: PolicyStore = {
          list: () => deps.policy.list(),
          get(path) {
            let read = records.get(path);
            if (!read) {
              read = reused(() => deps.policy.get(path), deps.now);
              records.set(path, read);
            }
            return read();
          },
        };
        return brokerHost({
          store: policy,
          upstream: deps.upstream,
          definitionFor: deps.definitionFor,
          docsFor: deps.docsFor,
          quotas: quotaContext(run.project),
          control: callGate(control, run.project),
          // Resolved before the first call is forwarded; a failure refuses every call.
          maxDataClass: exposure(run.project).then((found) => found.allowed),
        });
      },
    });
  };
}
