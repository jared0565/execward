import { describe, expect, it } from "vitest";
import { fakeToken } from "../src/adversarial/fixtures";
import { runCodeTool, type CodeToolDeps, type RunHost } from "../src/code-tool/run";
import { codeToolOutputSchema } from "../src/contracts/code-tool";
import type { ExecutionOutcome, ExecutionRequest, Executor } from "../src/executor";
import { RUN_LIMITS, SCRIPT_LIMITS } from "../src/limits";

/** A host whose run has read nothing, so output hygiene has nothing to withhold. */
const EMPTY_HOST: RunHost = {
  callTool: async (path, args) => ({ path, args }),
  search: async () => [],
  describe: async () => ({}),
  provenance: () => ({ dataClass: undefined, records: 0 }),
};

/** An executor that does not run the script: it does what the test tells it to. */
function scriptedExecutor(behaviour: (request: ExecutionRequest) => Promise<ExecutionOutcome>): Executor & { requests: ExecutionRequest[] } {
  const requests: ExecutionRequest[] = [];
  return {
    name: "scripted",
    requests,
    async execute(request) {
      requests.push(request);
      return behaviour(request);
    },
  };
}

function deps(executor: Executor, host: RunHost = EMPTY_HOST): CodeToolDeps {
  let clock = 1_000;
  return { executor, hostFor: () => host, newRunId: () => "run-1", now: () => (clock += 25) };
}

const completed = (result: unknown, extra: Partial<{ truncated: boolean; logs: string[] }> = {}): ExecutionOutcome => ({
  status: "completed",
  result,
  logs: extra.logs ?? [],
  truncated: extra.truncated ?? false,
});

const INPUT = { script: "return 1;", project: "demo" };

describe("the code tool's input contract (contract 1)", () => {
  it.each([
    ["nothing", undefined],
    ["text", "return 1;"],
    ["no project", { script: "return 1;" }],
    ["no script", { project: "demo" }],
    ["an empty script", { script: "", project: "demo" }],
    ["a script that is not text", { script: 7, project: "demo" }],
    ["an unknown field", { ...INPUT, sudo: true }],
    ["too many criteria", { ...INPUT, criteria: Array.from({ length: 21 }, () => "x") }],
  ])("refuses %s with schema_invalid, without running anything", async (_label, input) => {
    const executor = scriptedExecutor(async () => completed(1));
    const output = await runCodeTool(input, deps(executor));
    expect(output).toMatchObject({ status: "refused", error: { code: "schema_invalid" } });
    expect(executor.requests).toEqual([]);
    expect(codeToolOutputSchema.safeParse(output).success).toBe(true);
  });

  it("accepts intent and criteria", async () => {
    const output = await runCodeTool({ ...INPUT, intent: "count issues", criteria: ["is a number"] }, deps(scriptedExecutor(async () => completed(1))));
    expect(output.status).toBe("completed");
  });
});

describe("the static check is in the run path (FR-33)", () => {
  it.each([
    ["eval", `return eval("1");`],
    ["a global outside the Sandbox API", `return fetch("https://example.com");`],
    ["a secret-shaped literal", `return "${fakeToken()}";`],
    ["an oversized script", `// ${"x".repeat(SCRIPT_LIMITS.maxScriptBytes)}`],
    ["invalid JavaScript", `return +;`],
  ])("refuses %s with static_check_failed and never calls the executor", async (_label, script) => {
    const executor = scriptedExecutor(async () => completed(1));
    const output = await runCodeTool({ script, project: "demo" }, deps(executor));
    expect(output).toMatchObject({ status: "refused", error: { code: "static_check_failed" } });
    expect(executor.requests).toEqual([]);
    expect(JSON.stringify(output)).not.toContain(fakeToken());
  });

  it("checks the script even when the rest of the input is wrong", async () => {
    const output = await runCodeTool({ script: `return eval("1");` }, deps(scriptedExecutor(async () => completed(1))));
    expect(output).toMatchObject({ status: "refused", error: { code: "static_check_failed" } });
  });

  it("puts the script's SHA-256 in the report, for a run and for a refusal", async () => {
    const ran = await runCodeTool(INPUT, deps(scriptedExecutor(async () => completed(1))));
    const refused = await runCodeTool({ script: `return eval("1");`, project: "demo" }, deps(scriptedExecutor(async () => completed(1))));
    expect(ran.report.scriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(refused.report.scriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ran.report.scriptHash).not.toBe(refused.report.scriptHash);
  });
});

describe("the code tool's output contract (contract 2)", () => {
  it("returns the final value with a run report", async () => {
    const executor = scriptedExecutor(async (request) => {
      await request.host.callTool("github_list_issues", { page: 1 });
      await request.host.callTool("github_list_issues", { page: 2 });
      await request.host.callTool("github_get_issue", { number: 7 });
      return completed({ open: 3 }, { logs: ["two pages"] });
    });
    const output = await runCodeTool(INPUT, deps(executor));
    expect(output).toEqual({
      status: "completed",
      result: { open: 3 },
      truncated: false,
      logs: ["two pages"],
      untrusted: true,
      report: {
        runId: "run-1",
        scriptHash: output.report.scriptHash,
        callsByTool: { github_list_issues: 2, github_get_issue: 1 },
        recordsRead: 0,
        recordsWritten: 0,
        errors: [],
        retries: 0,
        assertions: { passed: 0, failed: 0 },
        sideEffects: [],
        verification: "not_applicable",
        durationMs: 25,
      },
    });
    expect(codeToolOutputSchema.parse(output)).toEqual(output);
  });

  it("gives the executor the script, the run id and the default limits", async () => {
    const executor = scriptedExecutor(async () => completed(1));
    await runCodeTool(INPUT, deps(executor));
    expect(executor.requests[0]).toMatchObject({ runId: "run-1", script: "return 1;", limits: RUN_LIMITS });
  });

  it("returns an oversized final value with a truncation notice (FR-5)", async () => {
    const output = await runCodeTool(INPUT, deps(scriptedExecutor(async () => completed('"xxxxxxxx', { truncated: true }))));
    expect(output).toMatchObject({ status: "completed", truncated: true, result: { partial: '"xxxxxxxx' } });
    if (output.status !== "completed") return;
    const notice = (output.result as { notice: string }).notice;
    expect(notice).toContain(`${RUN_LIMITS.maxResultBytes}-byte limit`);
    expect(notice).toContain("Return less");
  });

  it.each([
    ["script_error", "script_error"],
    ["assertion_failed", "assertion_failed"],
    ["timeout", "timeout"],
    ["quota_exceeded", "quota_exceeded"],
    ["sandbox_fault", "sandbox_fault"],
  ] as const)("maps a %s failure onto the %s error code", async (kind, code) => {
    const executor = scriptedExecutor(async () => ({ status: "failed", failure: { kind, message: "what happened", line: 4 }, logs: ["before it failed"] }));
    const output = await runCodeTool(INPUT, deps(executor));
    expect(output).toMatchObject({
      status: "error",
      error: { code, message: "what happened", line: 4 },
      logs: ["before it failed"],
      report: { errors: [{ code, message: "what happened", line: 4 }], assertions: { failed: kind === "assertion_failed" ? 1 : 0 } },
    });
    expect(codeToolOutputSchema.safeParse(output).success).toBe(true);
  });

  it("counts a call the host refused", async () => {
    const host: RunHost = { ...EMPTY_HOST, callTool: async () => Promise.reject(new Error("refused")) };
    const executor = scriptedExecutor(async (request) => {
      await request.host.callTool("github_delete_repo", {}).catch(() => undefined);
      return completed(null);
    });
    const output = await runCodeTool(INPUT, deps(executor, host));
    expect(output.report.callsByTool).toEqual({ github_delete_repo: 1 });
  });

  it("reports an executor that throws as a sandbox fault, and runs nothing else", async () => {
    let upstreamCalls = 0;
    const host: RunHost = { ...EMPTY_HOST, callTool: async () => ++upstreamCalls };
    const executor = scriptedExecutor(async () => {
      throw new Error("isolate lost");
    });
    const output = await runCodeTool(INPUT, deps(executor, host));
    expect(output).toMatchObject({ status: "error", error: { code: "sandbox_fault", message: "the executor failed: isolate lost" } });
    expect(upstreamCalls).toBe(0);
    expect(executor.requests.length).toBe(1);
  });

  it("never sends a reply the contract does not describe", async () => {
    const executor = scriptedExecutor(async () => ({ status: "failed", failure: { kind: "script_error", message: "x", line: -3 }, logs: [] }));
    const output = await runCodeTool(INPUT, deps(executor));
    expect(output).toMatchObject({ status: "error", error: { code: "sandbox_fault" } });
    expect(codeToolOutputSchema.safeParse(output).success).toBe(true);
  });
});
