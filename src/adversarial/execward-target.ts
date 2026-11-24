/**
 * ExecWard itself as a target for the adversarial suite (FR-31, Gate 1).
 *
 * The stub in ./stub-target has no defences and proves the suite can tell.
 * This is the other half: the real `code` tool, through `codeToolService` as a
 * served route must use it, with the real static check, executor, broker,
 * policy table, pins, quotas, switches, audit log, console sign-in rule and
 * escalation queue. Only the stores are in memory, and the upstream tools are
 * the suite's own counted fixtures.
 *
 * It offers a probe only for what Phase 1 has built. An attack on a part that
 * does not exist yet has no probe, so the suite reports it as open: see
 * ./expected for which, and the task that closes each.
 *
 * It must run where the executor's isolation is real: inside a Worker.
 */
import { auditLog, memoryAuditStore, verifyChain, type AuditEntry } from "../audit/log";
import { memoryProjectStore } from "../broker/exposure";
import { memoryPolicyStore } from "../broker/policy-store";
import { memoryQuotaStore } from "../broker/quotas";
import { attemptGate } from "../code-tool/attempts";
import { ownerConsole, requireOwner, type Principal } from "../console/console";
import { memoryControlStore } from "../console/control";
import { escalationQueue, memoryEscalationStore } from "../console/escalations";
import type { PolicyRecord } from "../contracts/policy";
import { toolPath } from "../contracts/sandbox-api";
import type { Executor } from "../executor";
import { RUN_LIMITS } from "../limits";
import { memoryMeterSink, meter } from "../meter/meter";
import { memoryMetricsSink } from "../metrics/metrics";
import type { ToolDefinitionRecord } from "../registry/definition";
import { approve, registry, type Pin } from "../registry/registry";
import { typingsFor } from "../registry/typings";
import { codeToolService } from "../service";
import type { RunResult, ScriptRun, Target, ToolFixture } from "./types";

const PROJECT = "adversarial";

function definitionOf(fixture: ToolFixture): ToolDefinitionRecord {
  return {
    server: fixture.server,
    tool: fixture.tool,
    description: fixture.description,
    inputSchema: fixture.inputSchema,
    ...(fixture.outputSchema ? { outputSchema: fixture.outputSchema } : {}),
  };
}

export function execwardTarget(deps: { readonly executor: Executor; readonly now?: () => number }): Target {
  const now = deps.now ?? (() => Date.now());
  const owner = (): Principal => ({ kind: "owner", id: "owner:adversarial", twoFactorAt: now() });
  let runs = 0;

  async function runScript(run: ScriptRun): Promise<RunResult> {
    // Every tool is approved and pinned as the owner would have done it. A tool
    // with no policy in its fixture gets no policy record, and nothing else.
    const pins: Pin[] = [];
    const records: PolicyRecord[] = [];
    const fixtures = new Map<string, ToolFixture>();
    for (const fixture of run.tools) {
      const pin = await approve(definitionOf(fixture));
      pins.push(pin);
      fixtures.set(pin.path, fixture);
      if (!fixture.policy) continue;
      const { callsPerRun, ...policy } = fixture.policy;
      records.push({
        server: fixture.server,
        tool: fixture.tool,
        definitionHash: pin.hash,
        ...policy,
        destinationAllowlist: [...policy.destinationAllowlist],
        quotas: callsPerRun === undefined ? {} : { callsPerRun },
      });
    }
    const changed = run.redefineAfterApproval;
    const pinned = registry({
      pins,
      // What the upstream says about the tool now: as approved, unless the case changed it since.
      current: async (path) => {
        const pin = pins.find((item) => item.path === path);
        if (!pin) return undefined;
        return changed?.path === path ? { ...pin.definition, description: changed.description } : pin.definition;
      },
    });

    const control = memoryControlStore();
    const audit = memoryAuditStore();
    const console_ = ownerConsole({ control, audit: auditLog(audit, now), now });
    await console_.completeOnboarding(owner(), { profile: "lightweight" });
    await console_.setCodeMode(owner(), true);

    const service = codeToolService({
      executor: deps.executor,
      policy: memoryPolicyStore(records),
      // Confidential, so a case that reads confidential data is judged on where the data goes next.
      projects: memoryProjectStore([{ project: PROJECT, dataClass: "confidential" }]),
      quotas: memoryQuotaStore(),
      audit,
      control,
      upstream: async ({ record, args }) => {
        const fixture = fixtures.get(toolPath(record.server, record.tool));
        if (!fixture) throw new Error("no such tool");
        return fixture.handler(args);
      },
      definitionFor: (record) => pinned.definitionFor(record),
      docsFor: (path) => pinned.docsFor(path),
      meter: meter({ level: "off", sink: memoryMeterSink() }),
      metrics: memoryMetricsSink(),
      now,
      newRunId: () => `adversarial-${++runs}`,
      // The caps a case sets are the ones it then tries to pass.
      limits: {
        ...RUN_LIMITS,
        ...(run.maxHostCalls === undefined ? {} : { maxHostCalls: run.maxHostCalls }),
        ...(run.wallClockMs === undefined ? {} : { wallClockMs: run.wallClockMs }),
      },
    });
    const output = await service({ script: run.script, project: PROJECT }, { providerRoute: "anthropic_api_commercial", attempts: attemptGate() });
    return {
      status: output.status,
      ...(output.status === "error" || output.status === "refused" ? { errorCode: output.error.code } : {}),
      ...(output.status === "completed" ? { result: output.result } : {}),
      ...((output.status === "completed" || output.status === "error") && output.untrusted === true ? { untrusted: true } : {}),
      logs: output.status === "completed" || output.status === "error" ? (output.logs ?? []) : [],
    };
  }

  const probeAudit = memoryAuditStore();
  const probeLog = auditLog(probeAudit, now);

  return {
    name: "ExecWard (Phase 1)",
    runScript,

    async typingsFor(tools) {
      // A model is shown typings only for tools that were approved.
      const approved: ToolDefinitionRecord[] = [];
      for (const fixture of tools) {
        try {
          approved.push((await approve(definitionOf(fixture))).definition);
        } catch {
          // Refused at approval: it never reaches the typings.
        }
      }
      return typingsFor(approved);
    },

    auditLog: {
      async record(event) {
        await probeLog.record({ kind: "adversarial_probe", runId: "adversarial-probe", project: PROJECT, body: { event } });
        return probeAudit.entries.map((entry) => JSON.stringify(entry));
      },
      async verify(lines) {
        try {
          return (await verifyChain(lines.map((line) => JSON.parse(line) as AuditEntry))).ok;
        } catch {
          return false;
        }
      },
    },

    // The console has no password of its own. What it asks is a signed-in owner
    // with a recent second factor, which is the rule tried here.
    async consoleSignIn(credentials) {
      const principal: Principal = { kind: "owner", id: "owner:adversarial", twoFactorAt: credentials.secondFactor === null ? undefined : now() };
      try {
        requireOwner(principal, now());
        return true;
      } catch {
        return false;
      }
    },

    // ExecWard opens no listener on this computer: it is a Worker, reached only through Cloudflare.
    localRequest: async () => "no_listener",

    async processReach() {
      const host = globalThis as { process?: { env?: Record<string, string | undefined> }; navigator?: { userAgent?: string } };
      const env = host.process?.env ?? {};
      return {
        shellEnvironment: ["PATH", "Path", "HOME", "USERPROFILE"].some((name) => typeof env[name] === "string" && env[name] !== ""),
        // A Worker has no file system of the computer it runs on. Anywhere else, assume it can read files.
        filesOutsideProject: host.navigator?.userAgent !== "Cloudflare-Workers",
      };
    },

    async securityException(project) {
      const control = memoryControlStore();
      const queue = escalationQueue({ store: memoryEscalationStore(), control, audit: auditLog(memoryAuditStore(), now), now, newId: () => crypto.randomUUID() });
      await queue.raise({
        trigger: "security_exception",
        project,
        runId: "adversarial-run",
        error: { code: "policy_denied", message: "a call was refused by policy" },
        context: { toolPath: "github_get_issue" },
      });
      const shown = (await queue.list(owner())).find((item) => item.project === project);
      return {
        pausedProjects: [...control.current().pausedProjects],
        // The owner is shown which run and which tool raised it. The planted text itself is never copied into the queue.
        sourceShown: shown?.runId !== undefined && shown.context.toolPath !== undefined && shown.error !== undefined,
      };
    },
  };
}
