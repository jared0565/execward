import { describe, expect, it } from "vitest";
import { fakeToken } from "../src/adversarial/fixtures";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { attemptGate, type Escalation } from "../src/code-tool/attempts";
import { NOTICE_ALLOWANCE_BYTES, releaseGate, type GateInput } from "../src/code-tool/release-gate";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import { codeToolOutputSchema } from "../src/contracts/code-tool";
import type { DataClass } from "../src/contracts/policy";
import type { ExecutionOutcome, Executor } from "../src/executor";
import { RUN_LIMITS } from "../src/limits";

const CLEAN: GateInput = { result: { count: 3 }, logs: ["read 3 issues"], read: undefined, allowed: "public", masked: false, maxResultBytes: RUN_LIMITS.maxResultBytes };

describe("the release gate's fixed checks (FR-47)", () => {
  it("passes a clean reply through all four checks", () => {
    expect(releaseGate(CLEAN)).toEqual({
      checks: [
        { name: "format", passed: true },
        { name: "size", passed: true },
        { name: "secret_scan", passed: true },
        { name: "data_class", passed: true },
      ],
    });
  });

  it("passes a reply with no result at all", () => {
    expect(releaseGate({ ...CLEAN, result: undefined }).failure).toBeUndefined();
  });

  it.each([
    ["the result", { result: { note: `token ${fakeToken()}` } }],
    ["a nested field of the result", { result: { rows: [{ a: 1 }, { b: { c: fakeToken() } }] } }],
    ["a log line", { logs: ["ok", `debug ${fakeToken()}`] }],
    ["an error message", { result: undefined, errorMessage: `failed with ${fakeToken()}` }],
  ])("withholds a reply with a secret in %s, and does not repeat the secret", (_label, change) => {
    const verdict = releaseGate({ ...CLEAN, ...change });
    expect(verdict.failure).toEqual({ code: "policy_denied", message: "the release gate withheld the reply: it contains what looks like a GitHub token" });
    expect(verdict.checks.find((check) => check.name === "secret_scan")).toMatchObject({ passed: false });
    expect(JSON.stringify(verdict)).not.toContain(fakeToken());
  });

  it("finds a secret on every call, not every other call", () => {
    const withSecret = { ...CLEAN, result: fakeToken() };
    for (let n = 0; n < 4; n++) expect(releaseGate(withSecret).failure?.code, `call ${n + 1}`).toBe("policy_denied");
  });

  it("withholds a result that is not plain JSON", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(releaseGate({ ...CLEAN, result: loop }).failure).toEqual({ code: "sandbox_fault", message: "the release gate withheld the reply: the result is not valid JSON" });
    expect(releaseGate({ ...CLEAN, result: { n: 10n } }).failure?.code).toBe("sandbox_fault");
  });

  it("withholds a result over the size limit, and allows room for the cut notice", () => {
    const limit = 1_000;
    const text = (bytes: number) => "x".repeat(bytes - 2);
    expect(releaseGate({ ...CLEAN, maxResultBytes: limit, result: text(limit + NOTICE_ALLOWANCE_BYTES) }).failure).toBeUndefined();
    expect(releaseGate({ ...CLEAN, maxResultBytes: limit, result: text(limit + NOTICE_ALLOWANCE_BYTES + 1) }).failure).toMatchObject({ code: "sandbox_fault" });
  });

  it("withholds a reply that carries data above the project's class without having been masked", () => {
    const cases: [DataClass | undefined, DataClass, boolean, boolean][] = [
      [undefined, "public", false, true],
      ["public", "public", false, true],
      ["internal", "confidential", false, true],
      ["confidential", "internal", true, true],
      ["confidential", "internal", false, false],
      ["client_personal", "public", false, false],
    ];
    for (const [read, allowed, masked, released] of cases) {
      const verdict = releaseGate({ ...CLEAN, read, allowed, masked });
      expect(verdict.failure === undefined, `${String(read)} in ${allowed}, masked ${masked}`).toBe(released);
      if (!released) expect(verdict.failure?.code).toBe("policy_denied");
    }
  });

  it("reports the first failure when several checks fail, and lists them all", () => {
    const verdict = releaseGate({ ...CLEAN, result: fakeToken(), read: "confidential" });
    expect(verdict.failure?.message).toContain("GitHub token");
    expect(verdict.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(["secret_scan", "data_class"]);
  });

  it("has no input that turns a fail into a pass", () => {
    // The whole input is the reply and three facts about the run. There is no override field.
    const keys: (keyof GateInput)[] = ["result", "logs", "errorMessage", "read", "allowed", "masked", "maxResultBytes"];
    expect(Object.keys({ ...CLEAN, errorMessage: "" }).sort()).toEqual([...keys].sort());
  });
});

describe("the release gate in the code tool (FR-47, FR-48)", () => {
  const HOST: RunHost = { callTool: async () => 1, search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }) };

  function run(outcome: ExecutionOutcome, input: Record<string, unknown> = {}) {
    const store = memoryAuditStore();
    const escalations: Escalation[] = [];
    const executor: Executor = { name: "scripted", execute: async () => outcome };
    const output = runCodeTool(
      { script: "return 1;", project: "demo", ...input },
      { executor, audit: auditLog(store, () => 0), hostFor: () => HOST, newRunId: () => "run-1", now: () => 0, attempts: attemptGate({ onEscalate: (escalation) => escalations.push(escalation) }) },
    );
    const logged = (): Record<string, unknown>[] => store.entries.map((entry) => ({ kind: entry.kind, ...(JSON.parse(entry.content ?? "{}") as Record<string, unknown>) }));
    return { output, logged, escalations };
  }
  const completed = (result: unknown, logs: string[] = []): ExecutionOutcome => ({ status: "completed", result, logs, truncated: false });

  it("marks a released result unreviewed, never passed: no independent reviewer exists", async () => {
    const { output, logged } = run(completed({ count: 3 }));
    const reply = await output;
    expect(reply).toMatchObject({ status: "completed", result: { count: 3 }, report: { verification: "unreviewed" } });
    expect(logged()[1]).toMatchObject({ kind: "run_finished", report: { verification: "unreviewed" }, releaseGate: [{ name: "format", passed: true }, { passed: true }, { passed: true }, { passed: true }] });
    expect(codeToolOutputSchema.safeParse(reply).success).toBe(true);
  });

  it("does not hand over a result that fails a check", async () => {
    const token = fakeToken();
    const { output, logged, escalations } = run(completed({ found: token }, ["looking"]));
    const reply = await output;
    expect(reply).toEqual({
      status: "error",
      error: { code: "policy_denied", message: "the release gate withheld the reply: it contains what looks like a GitHub token" },
      report: { ...reply.report, verification: "failed", errors: [{ code: "policy_denied", message: "the release gate withheld the reply: it contains what looks like a GitHub token" }] },
    });
    expect(JSON.stringify(reply)).not.toContain(token);
    expect(JSON.stringify(logged()[1])).not.toContain(token);
    expect(logged()[1]).toMatchObject({ kind: "run_finished", status: "error", security: true });
    // A gate failure is a security failure: the task is closed and goes to a person.
    expect(escalations.map((escalation) => escalation.reason)).toEqual(["security"]);
  });

  it("checks the logs and the script's own error text too", async () => {
    const token = fakeToken();
    const inLogs = await run(completed(1, [`key=${token}`])).output;
    expect(inLogs).toMatchObject({ status: "error", error: { code: "policy_denied" }, report: { verification: "failed" } });
    const thrown = await run({ status: "failed", failure: { kind: "script_error", message: `bad ${token}` }, logs: [] }).output;
    expect(thrown).toMatchObject({ status: "error", error: { code: "policy_denied" }, report: { verification: "failed" } });
    expect(JSON.stringify([inLogs, thrown])).not.toContain(token);
  });

  it("claims nothing for a run that failed on its own or never started", async () => {
    const failed = await run({ status: "failed", failure: { kind: "timeout", message: "the run reached its time limit" }, logs: [] }).output;
    expect(failed).toMatchObject({ status: "error", error: { code: "timeout" }, report: { verification: "not_applicable" } });
    const refused = await run(completed(1), { script: "return fetch('https://example.com');" }).output;
    expect(refused).toMatchObject({ status: "refused", report: { verification: "not_applicable" } });
  });

  it("keeps a failed assertion in the report when the gate also withholds the reply", async () => {
    const reply = await run({ status: "failed", failure: { kind: "assertion_failed", message: `expected ${fakeToken()}`, line: 1 }, logs: [] }).output;
    expect(reply.report).toMatchObject({ verification: "failed", assertions: { failed: 1 } });
  });

  it("records the criteria before the run, marked as the model's own, and does not judge them", async () => {
    const criteria = ["counts every open issue", "names the oldest one"];
    const { output, logged } = run(completed({ count: 3 }), { criteria, intent: "count open issues" });
    const reply = await output;
    expect(reply.report).toMatchObject({ criteria: { source: "model_supplied", items: criteria }, verification: "unreviewed" });
    expect(logged()[0]).toMatchObject({ kind: "run_started", criteria: { source: "model_supplied", items: criteria } });
    // A result that plainly ignores the criteria is still released: code cannot tell.
    expect(reply.status).toBe("completed");
  });

  it("leaves criteria out of the report when none were given", async () => {
    const reply = await run(completed(1)).output;
    expect("criteria" in reply.report).toBe(false);
    const empty = await run(completed(1), { criteria: [] }).output;
    expect("criteria" in empty.report).toBe(false);
  });
});
