import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { attemptGate, type Escalation } from "../src/code-tool/attempts";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import { ERROR_CODES, type ErrorCode } from "../src/contracts/errors";
import type { ExecutionOutcome, Executor } from "../src/executor";
import { SELF_CORRECTION } from "../src/limits";

const INPUT = { script: "return 1;", project: "demo" };
const OK: ExecutionOutcome = { status: "completed", result: 1, logs: [], truncated: false };
const BROKEN: ExecutionOutcome = { status: "failed", failure: { kind: "script_error", message: "x is not defined", line: 1 }, logs: [] };
const TIMED_OUT: ExecutionOutcome = { status: "failed", failure: { kind: "timeout", message: "the run reached its time limit" }, logs: [] };

const HOST: RunHost = { callTool: async () => 1, search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }) };

/** One task: a gate, and a code tool whose runs end the way the test lists, in order. */
function task(outcomes: readonly (ExecutionOutcome | "denied")[], maxRetries?: number) {
  const escalations: Escalation[] = [];
  const gate = attemptGate({ ...(maxRetries === undefined ? {} : { maxRetries }), onEscalate: (escalation) => escalations.push(escalation) });
  const store = memoryAuditStore();
  let executed = 0;
  let run = 0;
  const executor: Executor = {
    name: "scripted",
    async execute() {
      const outcome = outcomes[executed++] ?? OK;
      return outcome === "denied" ? OK : outcome;
    },
  };
  const attempt = (input: unknown = INPUT) => {
    const denied = outcomes[executed] === "denied";
    const host: RunHost = denied ? { ...HOST, securityError: () => ({ code: "policy_denied", message: "the tool has no policy record" }) } : HOST;
    return runCodeTool(input, { executor, audit: auditLog(store, () => 0), hostFor: () => host, newRunId: () => `run-${++run}`, now: () => 0, attempts: gate });
  };
  return { attempt, gate, escalations, executed: () => executed, kinds: () => store.entries.map((entry) => entry.kind) };
}

describe("self-correction (FR-41)", () => {
  it("allows two retries by default", () => {
    expect(SELF_CORRECTION.maxRetries).toBe(2);
  });

  it("returns a fixable failure to the model and lets it try again", async () => {
    const { attempt, gate, escalations } = task([BROKEN, OK]);
    expect(await attempt()).toMatchObject({ status: "error", error: { code: "script_error" }, report: { retries: 0 } });
    expect(gate.remaining()).toBe(1);
    expect(await attempt()).toMatchObject({ status: "completed", report: { retries: 1 } });
    expect(escalations).toEqual([]);
  });

  it("allows the first run and two retries, then refuses a third retry and escalates once", async () => {
    const { attempt, gate, escalations, executed, kinds } = task([BROKEN, TIMED_OUT, BROKEN, OK]);
    expect((await attempt()).report.retries).toBe(0);
    expect((await attempt()).report.retries).toBe(1);
    expect(escalations).toEqual([]);
    expect(await attempt()).toMatchObject({ status: "error", error: { code: "script_error" }, report: { retries: 2 } });
    expect(escalations).toEqual([{ reason: "retries_exhausted", error: { code: "script_error", message: "x is not defined", line: 1 }, runId: "run-3" }]);
    expect(gate.remaining()).toBe(0);

    const fourth = await attempt();
    expect(fourth).toMatchObject({ status: "refused", error: { code: "quota_exceeded", message: "the retry limit for this task was reached (2 retries); it has been escalated" } });
    expect(executed()).toBe(3);
    await attempt();
    expect(executed()).toBe(3);
    expect(escalations.length).toBe(1);
    // Refused attempts are on record like any other refusal.
    expect(kinds().slice(-2)).toEqual(["run_refused", "run_refused"]);
  });

  it("escalates a policy denial at once, with no retry", async () => {
    const { attempt, gate, escalations, executed } = task(["denied", OK]);
    expect(await attempt()).toMatchObject({ status: "error", error: { code: "policy_denied" } });
    expect(escalations).toEqual([{ reason: "security", error: { code: "policy_denied", message: "the tool has no policy record" }, runId: "run-1" }]);
    expect(gate.remaining()).toBe(0);
    expect(await attempt()).toMatchObject({
      status: "refused",
      error: { code: "policy_denied", message: "this task was ended by a security failure and cannot be retried; it has been escalated" },
    });
    expect(executed()).toBe(1);
  });

  it("escalates a script refused by the static check at once: a model cannot probe the check", async () => {
    const { attempt, escalations, executed } = task([OK, OK]);
    expect(await attempt({ script: "return fetch('https://example.com');", project: "demo" })).toMatchObject({ status: "refused", error: { code: "static_check_failed" } });
    expect(escalations).toMatchObject([{ reason: "security", error: { code: "static_check_failed" } }]);
    expect(await attempt()).toMatchObject({ status: "refused", error: { code: "static_check_failed" } });
    expect(executed()).toBe(0);
  });

  it("never retries any security code, and retries only the codes marked retryable", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES) as [ErrorCode, (typeof ERROR_CODES)[ErrorCode]][]) {
      const escalations: Escalation[] = [];
      const gate = attemptGate({ onEscalate: (escalation) => escalations.push(escalation) });
      gate.settle({ status: "error", error: { code, message: "m" }, report: { runId: "r", scriptHash: "0".repeat(64), callsByTool: {}, recordsRead: 0, recordsWritten: 0, errors: [], retries: 0, assertions: { passed: 0, failed: 0 }, sideEffects: [], verification: "not_applicable", durationMs: 0 } });
      if (spec.security) expect(escalations.map((escalation) => escalation.reason), code).toEqual(["security"]);
      else if (!spec.retryable) expect(escalations.map((escalation) => escalation.reason), code).toEqual(["not_retryable"]);
      else expect(escalations, code).toEqual([]);
      expect(gate.blocked() === undefined, code).toBe(spec.retryable);
    }
  });

  it("counts failures in a row: a success starts the count again", async () => {
    const { attempt, gate, escalations } = task([BROKEN, BROKEN, OK, BROKEN, BROKEN, OK]);
    for (let n = 0; n < 6; n++) await attempt();
    expect(escalations).toEqual([]);
    expect(gate.remaining()).toBe(2);
  });

  it("counts a refused but fixable request as a failed attempt", async () => {
    const { attempt, gate } = task([OK]);
    expect(await attempt({ script: "return 1;" })).toMatchObject({ status: "refused", error: { code: "schema_invalid" }, report: { retries: 0 } });
    expect(gate.remaining()).toBe(1);
  });

  it("honours a lower limit: with no retries allowed, the first failure closes the task", async () => {
    const { attempt, escalations, executed } = task([BROKEN, OK], 0);
    await attempt();
    expect(escalations.map((escalation) => escalation.reason)).toEqual(["retries_exhausted"]);
    expect((await attempt()).status).toBe("refused");
    expect(executed()).toBe(1);
  });

  it("keeps each task's count separate", async () => {
    const first = task([BROKEN, BROKEN, BROKEN]);
    for (let n = 0; n < 3; n++) await first.attempt();
    const second = task([OK]);
    expect((await second.attempt()).status).toBe("completed");
  });
});
