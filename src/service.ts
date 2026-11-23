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
import { exposureFor, type Exposure, type Gate, type ProjectStore, CLIENT_DATA_GATE } from "./broker/exposure";
import type { PolicyStore } from "./broker/policy-store";
import { admitRun, releaseRun, type QuotaStore } from "./broker/quotas";
import type { AttemptGate } from "./code-tool/attempts";
import { callGate, runGate, type ControlStore } from "./console/control";
import type { MeterFactory } from "./meter/meter";
import type { MetricsSink } from "./metrics/metrics";
import { runCodeTool } from "./code-tool/run";
import type { CodeToolOutput } from "./contracts/code-tool";
import type { PolicyRecord } from "./contracts/policy";
import type { Executor } from "./executor";

export interface CodeToolServiceDeps {
  readonly executor: Executor;
  readonly policy: PolicyStore;
  readonly projects: ProjectStore;
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
  /** Only tests pass this. Production uses `CLIENT_DATA_GATE`. */
  readonly gate?: Gate;
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
    // Worked out once per run and shared, so the broker and the reply use the same answer.
    const exposures = new Map<string, Promise<Exposure>>();
    const exposure = (project: string): Promise<Exposure> => {
      let found = exposures.get(project);
      if (!found) {
        found = exposureFor(deps.projects, project, caller.providerRoute, deps.gate ?? CLIENT_DATA_GATE);
        exposures.set(project, found);
      }
      return found;
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
      control: runGate(deps.control),
      exposure,
      admission: {
        admit: (run) => admitRun(quotaContext(run.project), run.runId, run.wallClockMs),
        release: (run) => releaseRun(quotaContext(run.project), run.runId),
      },
      hostFor: (run) =>
        brokerHost({
          store: deps.policy,
          upstream: deps.upstream,
          definitionFor: deps.definitionFor,
          docsFor: deps.docsFor,
          quotas: quotaContext(run.project),
          control: callGate(deps.control, run.project),
          // Resolved before the first call is forwarded; a failure refuses every call.
          maxDataClass: exposure(run.project).then((found) => found.allowed),
        }),
    });
  };
}
