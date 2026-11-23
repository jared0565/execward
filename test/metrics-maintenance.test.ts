import { describe, expect, it } from "vitest";
import { fakeToken } from "../src/adversarial/fixtures";
import { auditLog, memoryAuditStore, verifyChain } from "../src/audit/log";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import { INITIAL_CONTROL_STATE, memoryControlStore } from "../src/console/control";
import { escalationQueue, memoryEscalationStore } from "../src/console/escalations";
import { DIGEST_SUBJECT, notifier, URGENT_SUBJECT, type Email } from "../src/console/notify";
import type { ExecutionOutcome, Executor } from "../src/executor";
import { runMaintenance } from "../src/maintenance";
import { memoryMeterSink, meter } from "../src/meter/meter";
import { memoryMetricsSink, type MetricsSink } from "../src/metrics/metrics";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = 1_800_000_000_000;

describe("per-run metrics (NFR: observability)", () => {
  const host = (failing: string[] = []): RunHost => ({
    async callTool(path) {
      if (failing.includes(path)) throw new Error("upstream_error: PRIVATE-UPSTREAM-TEXT");
      return { rows: [1, 2, 3] };
    },
    search: async () => [],
    describe: async () => ({}),
    provenance: () => ({ dataClass: undefined, records: 3 }),
  });
  const calling = (tools: string[], end: ExecutionOutcome = { status: "completed", result: { count: 3 }, logs: [], truncated: false }): Executor => ({
    name: "scripted",
    async execute(request) {
      for (const tool of tools) await request.host.callTool(tool, {}).catch(() => undefined);
      return end;
    },
  });

  function run(executor: Executor, options: { input?: unknown; host?: RunHost; metered?: boolean; sink?: MetricsSink } = {}) {
    const sink = memoryMetricsSink();
    let clock = START;
    const output = runCodeTool(options.input ?? { script: "return 1;", project: "work" }, {
      executor,
      audit: auditLog(memoryAuditStore(), () => START),
      hostFor: () => options.host ?? host(),
      newRunId: () => "run-1",
      now: () => (clock += 40),
      metrics: options.sink ?? sink,
      ...(options.metered ? { meter: meter({ level: "summary", sink: memoryMeterSink() }) } : {}),
    });
    return { output, sink };
  }

  it("exports latency, outcome and whether it was a security event, for a run that worked", async () => {
    const { output, sink } = run(calling(["github_list_issues", "github_list_issues"]));
    const reply = await output;
    expect(sink.metrics).toEqual([
      { runId: "run-1", project: "work", status: "completed", securityEvent: false, durationMs: reply.report.durationMs, toolCalls: 2, failedCalls: 0, recordsRead: 3, retries: 0, verification: "unreviewed" },
    ]);
    expect(sink.metrics[0]?.durationMs).toBeGreaterThan(0);
  });

  it("marks a security event, and counts failed calls apart from the error that ended the run", async () => {
    const failing = await run(calling(["github_list_issues", "github_search"]), { host: host(["github_search"]) });
    await failing.output;
    expect(failing.sink.metrics[0]).toMatchObject({ status: "completed", securityEvent: false, toolCalls: 2, failedCalls: 1 });

    const refused = await run(calling([]), { input: { script: "return fetch('https://example.com');", project: "work" } });
    await refused.output;
    expect(refused.sink.metrics[0]).toMatchObject({ status: "refused", errorCode: "static_check_failed", securityEvent: true, toolCalls: 0, failedCalls: 0 });

    const timedOut = await run(calling([], { status: "failed", failure: { kind: "timeout", message: "the run reached its time limit" }, logs: [] }));
    await timedOut.output;
    expect(timedOut.sink.metrics[0]).toMatchObject({ status: "error", errorCode: "timeout", securityEvent: false });
  });

  it("adds token estimates only when metering is on", async () => {
    const off = run(calling(["github_list_issues"]));
    await off.output;
    expect("tokens" in off.sink.metrics[0]!).toBe(false);
    const on = run(calling(["github_list_issues"]), { metered: true });
    await on.output;
    expect(on.sink.metrics[0]?.tokens).toEqual({ estimated: true, script: 3, returned: 3, keptOut: 4, estimatedSaving: -2 });
  });

  it("carries numbers and fixed codes only: no script, result, error text or secret", async () => {
    const token = fakeToken();
    const { output, sink } = run(calling(["github_search"], { status: "failed", failure: { kind: "script_error", message: `SCRIPT-ERROR-TEXT ${token}` }, logs: ["LOG-TEXT"] }), {
      host: host(["github_search"]),
      input: { script: "const a = 'SCRIPT-TEXT'; return a;", project: "work", intent: "INTENT-TEXT" },
    });
    await output;
    const exported = JSON.stringify(sink.metrics);
    for (const text of ["SCRIPT-TEXT", "SCRIPT-ERROR-TEXT", "LOG-TEXT", "INTENT-TEXT", "PRIVATE-UPSTREAM-TEXT", token, "github_search"]) expect(exported, text).not.toContain(text);
  });

  it("exports a metric even for input that is not a request", async () => {
    const { output, sink } = run(calling([]), { input: "not an object" });
    await output;
    expect(sink.metrics).toMatchObject([{ project: "unknown", status: "refused", errorCode: "schema_invalid" }]);
  });

  it("does not fail the run when metrics cannot be exported", async () => {
    const { output } = run(calling(["github_list_issues"]), { sink: { export: async () => Promise.reject(new Error("monitoring is down")) } });
    expect(await output).toMatchObject({ status: "completed", result: { count: 3 } });
  });
});

describe("scheduled housekeeping", () => {
  function setup() {
    let now = START;
    let ids = 0;
    const audit = memoryAuditStore();
    const log = auditLog(audit, () => now);
    const escalations = memoryEscalationStore();
    const control = memoryControlStore({ ...INITIAL_CONTROL_STATE, codeMode: true });
    const sent: Email[] = [];
    const notify = notifier({ mailer: { send: async (email) => void sent.push(email) }, baseUrl: "https://console.example.com" });
    const queue = escalationQueue({ store: escalations, control, audit: log, now: () => now, newId: () => `item${String(++ids).padStart(4, "0")}aBcDeFgHiJkLmN`, onRaised: (item) => notify.raised(item) });
    const swept: number[] = [];
    const deps = { audit, queue, escalations, notifier: notify, sweepCounters: async (at: number) => void swept.push(at), now: () => now };
    return { deps, queue, audit, log, escalations, sent, swept, advance: (ms: number) => (now += ms), time: () => now };
  }

  it("closes expired escalations and sends reminders on the frequent round", async () => {
    const { deps, queue, escalations, sent, advance } = setup();
    await queue.raise({ trigger: "repeated_failure", project: "work", runId: "run-1" });
    await queue.raise({ trigger: "security_exception", project: "work", runId: "run-2" });
    expect(await runMaintenance(deps, "frequent")).toEqual([
      { job: "expire_escalations", ok: true, detail: "0 closed" },
      { job: "send_reminders", ok: true, detail: "0 sent" },
    ]);
    advance(4 * HOUR);
    expect(await runMaintenance(deps, "frequent")).toEqual([
      { job: "expire_escalations", ok: true, detail: "1 closed" },
      { job: "send_reminders", ok: true, detail: "1 sent" },
    ]);
    expect([...escalations.items.values()].map((item) => item.status)).toEqual(["expired", "open"]);
    expect(sent.map((email) => email.subject)).toEqual([URGENT_SUBJECT, URGENT_SUBJECT]);
  });

  it("applies retention, sends the digest and sweeps counters on the daily round", async () => {
    const { deps, queue, audit, log, sent, swept, advance, time } = setup();
    await log.record({ kind: "test", runId: "old", project: "work", body: { text: "full text" } });
    advance(8 * DAY);
    await queue.raise({ trigger: "definition_changed", project: "work", runId: "run-3" });
    const results = await runMaintenance(deps, "daily");
    expect(results).toEqual([
      { job: "apply_retention", ok: true, detail: "1 entries had their text removed, 0 entries removed" },
      { job: "send_digest", ok: true, detail: "sent" },
      { job: "sweep_counters", ok: true, detail: "swept" },
    ]);
    expect(audit.entries[0]?.content).toBeNull();
    expect(await verifyChain(audit.entries, await audit.anchor())).toMatchObject({ ok: true });
    expect(sent.map((email) => email.subject)).toEqual([DIGEST_SUBJECT]);
    expect(swept).toEqual([time()]);
  });

  it("says so when there is nothing for the digest", async () => {
    const { deps } = setup();
    expect((await runMaintenance(deps, "daily"))[1]).toEqual({ job: "send_digest", ok: true, detail: "nothing waiting" });
  });

  it("carries on with the other jobs when one fails, and reports which", async () => {
    const { deps, audit } = setup();
    const broken = { ...deps, audit: { ...audit, expireContent: async () => Promise.reject(new Error("the audit table is locked")) }, sweepCounters: async () => Promise.reject(new Error("the counters table is missing")) };
    expect(await runMaintenance(broken, "daily")).toEqual([
      { job: "apply_retention", ok: false, detail: "the audit table is locked" },
      { job: "send_digest", ok: true, detail: "nothing waiting" },
      { job: "sweep_counters", ok: false, detail: "the counters table is missing" },
    ]);
  });

  it("runs without a notifier or a sweeper", async () => {
    const { deps } = setup();
    const bare = { audit: deps.audit, queue: deps.queue, escalations: deps.escalations, now: deps.now };
    expect((await runMaintenance(bare, "frequent")).map((result) => result.job)).toEqual(["expire_escalations"]);
    expect((await runMaintenance(bare, "daily")).map((result) => result.job)).toEqual(["apply_retention"]);
  });
});
