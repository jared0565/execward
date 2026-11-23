import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { MAX_REPORTED_CALL_ERRORS, runCodeTool, UNNAMED_CALL, type RunHost } from "../src/code-tool/run";
import { runReportSchema } from "../src/contracts/code-tool";
import type { DataClass } from "../src/contracts/policy";
import type { ExecutionOutcome, Executor } from "../src/executor";

const INPUT = { script: "return 1;", project: "demo" };

/** A host where each tool path either answers or throws the error text given for it. */
function host(failures: Record<string, string> = {}, read: { dataClass: DataClass | undefined; records: number } = { dataClass: undefined, records: 0 }): RunHost {
  return {
    async callTool(path) {
      const failure = failures[path];
      if (failure !== undefined) throw new Error(failure);
      return { from: path };
    },
    search: async () => [],
    describe: async () => ({}),
    provenance: () => read,
  };
}

/** Stands in for a script: calls the named tools, catching every error, then ends as told. */
function calling(tools: readonly string[], end: ExecutionOutcome = { status: "completed", result: "done", logs: [], truncated: false }): Executor {
  return {
    name: "scripted",
    async execute(request) {
      for (const tool of tools) await request.host.callTool(tool, {}).catch(() => undefined);
      return end;
    },
  };
}

function run(executor: Executor, runHost: RunHost = host(), input: unknown = INPUT) {
  const store = memoryAuditStore();
  let clock = 1_000;
  const output = runCodeTool(input, { executor, audit: auditLog(store, () => 0), hostFor: () => runHost, newRunId: () => "run-1", now: () => (clock += 25) });
  const logged = (): Record<string, unknown>[] => store.entries.map((entry) => ({ kind: entry.kind, ...(JSON.parse(entry.content ?? "{}") as Record<string, unknown>) }));
  return { output, logged };
}

describe("the run report (FR-39)", () => {
  it("lists every part of the record beside a result", async () => {
    const executor = calling(["github_list_issues", "github_list_issues", "github_get_commit"], { status: "completed", result: 3, logs: [], truncated: false, assertionsPassed: 2 });
    const { output } = run(executor, host({}, { dataClass: undefined, records: 41 }));
    const reply = await output;
    expect(reply.status).toBe("completed");
    expect(reply.report).toEqual({
      runId: "run-1",
      scriptHash: reply.report.scriptHash,
      callsByTool: { github_list_issues: 2, github_get_commit: 1 },
      recordsRead: 41,
      recordsWritten: 0,
      errors: [],
      retries: 0,
      assertions: { passed: 2, failed: 0 },
      sideEffects: [],
      verification: "unreviewed",
      durationMs: reply.report.durationMs,
    });
    expect(reply.report.scriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(reply.report.durationMs).toBeGreaterThan(0);
  });

  it("lists failed calls the script caught, so a script cannot hide them", async () => {
    const failures = { github_get_file: "schema_invalid: path is required", github_search: "upstream_error: 502 from upstream, body: PRIVATE-TEXT" };
    const reply = await run(calling(["github_list_issues", "github_get_file", "github_search"]), host(failures)).output;
    expect(reply.status).toBe("completed");
    expect(reply.report.errors).toEqual([
      { code: "schema_invalid", message: "a call to github_get_file failed" },
      { code: "upstream_error", message: "a call to github_search failed" },
    ]);
    // The code and the tool are given; the error's own words are not.
    expect(JSON.stringify(reply.report)).not.toContain("PRIVATE-TEXT");
    expect(reply.report.callsByTool).toEqual({ github_list_issues: 1, github_get_file: 1, github_search: 1 });
  });

  it("puts the error that ended the run first, then the calls that failed before it", async () => {
    const end: ExecutionOutcome = { status: "failed", failure: { kind: "script_error", message: "x is not defined", line: 3 }, logs: [] };
    const reply = await run(calling(["github_search"], end), host({ github_search: "upstream_error: down" })).output;
    expect(reply).toMatchObject({ status: "error", error: { code: "script_error" } });
    expect(reply.report.errors).toEqual([
      { code: "script_error", message: "x is not defined", line: 3 },
      { code: "upstream_error", message: "a call to github_search failed" },
    ]);
  });

  it("counts a failed assertion", async () => {
    const end: ExecutionOutcome = { status: "failed", failure: { kind: "assertion_failed", message: "every row has a date", line: 1 }, logs: [], assertionsPassed: 4 };
    const reply = await run(calling([], end)).output;
    expect(reply.report.assertions).toEqual({ passed: 4, failed: 1 });
  });

  it("lists a refusal that ended the run once, not twice", async () => {
    const refusing: RunHost = { ...host({ github_delete_repo: "policy_denied: no policy record" }), securityError: () => ({ code: "policy_denied", message: "no policy record" }) };
    const reply = await run(calling(["github_delete_repo"]), refusing).output;
    expect(reply.report.errors).toEqual([{ code: "policy_denied", message: "no policy record" }]);
    expect(reply.report.callsByTool).toEqual({ github_delete_repo: 1 });
  });

  it("reports a call that failed without an error code as an upstream error", async () => {
    const reply = await run(calling(["github_search"]), host({ github_search: "something broke" })).output;
    expect(reply.report.errors).toEqual([{ code: "upstream_error", message: "a call to github_search failed" }]);
  });

  it("lists at most 20 failed calls and says how many more there were", async () => {
    const tools = Array.from({ length: 27 }, () => "github_search");
    const reply = await run(calling(tools), host({ github_search: "upstream_error: down" })).output;
    expect(reply.report.errors.length).toBe(MAX_REPORTED_CALL_ERRORS + 1);
    expect(reply.report.errors.at(-1)).toEqual({ code: "upstream_error", message: "7 more failed calls are not listed" });
    expect(reply.report.callsByTool).toEqual({ github_search: 27 });
  });

  it("returns a report with a refusal too", async () => {
    const reply = await run(calling([]), host(), { script: "return fetch('https://example.com');", project: "demo" }).output;
    expect(reply.status).toBe("refused");
    expect(reply.report).toMatchObject({ runId: "run-1", callsByTool: {}, recordsRead: 0, errors: [{ code: "static_check_failed" }], verification: "not_applicable" });
  });

  it("keeps the count of records read when the executor itself fails", async () => {
    const broken: Executor = {
      name: "scripted",
      async execute(request) {
        await request.host.callTool("github_list_issues", {});
        throw new Error("isolate crashed");
      },
    };
    const reply = await run(broken, host({}, { dataClass: undefined, records: 12 })).output;
    expect(reply).toMatchObject({ status: "error", error: { code: "sandbox_fault" } });
    expect(reply.report).toMatchObject({ recordsRead: 12, callsByTool: { github_list_issues: 1 } });
  });

  it("matches the report contract whatever the outcome", async () => {
    const outcomes = [
      run(calling(["github_list_issues"])),
      run(calling(["github_search"]), host({ github_search: "upstream_error: down" })),
      run(calling([]), host(), { script: "return eval('1');", project: "demo" }),
      run(calling([]), host(), { project: "demo" }),
      run({ name: "scripted", execute: async () => Promise.reject(new Error("crash")) }),
    ];
    for (const { output } of outcomes) expect(runReportSchema.safeParse((await output).report).success).toBe(true);
  });
});

describe("the report in the audit log (FR-39)", () => {
  it("writes the report to the log exactly as it was returned", async () => {
    const { output, logged } = run(calling(["github_list_issues", "github_search"]), host({ github_search: "upstream_error: down" }, { dataClass: undefined, records: 5 }));
    const reply = await output;
    expect(logged().map((entry) => entry.kind)).toEqual(["run_started", "run_finished"]);
    expect(logged()[1]?.report).toEqual(reply.report);
  });

  it("writes the report of a refusal to the log", async () => {
    const { output, logged } = run(calling([]), host(), { script: "return eval('1');", project: "demo" });
    const reply = await output;
    expect(logged()).toMatchObject([{ kind: "run_refused" }]);
    expect(logged()[0]?.report).toEqual(reply.report);
  });
});

describe("the report does not carry withheld data out (FR-36)", () => {
  // The run read confidential data and the project may return only public data.
  const confidential = { dataClass: "confidential" as const, records: 3 };
  const smuggled = "LEAK_customer_4417_owes_9000";

  it("does not name a failed call's path when content is being withheld", async () => {
    const failures = { [smuggled]: "policy_denied: no policy record", [`${smuggled}_2`]: "upstream_error: x" };
    const { output, logged } = run(calling(["github_get_file", smuggled, `${smuggled}_2`]), host(failures, confidential));
    const reply = await output;
    expect(reply).toMatchObject({ status: "completed", masked: true });
    expect(reply.report.callsByTool).toEqual({ github_get_file: 1, [UNNAMED_CALL]: 2 });
    expect(reply.report.errors).toEqual([{ code: "upstream_error", message: `a call to ${UNNAMED_CALL} failed` }]);
    expect(JSON.stringify(reply)).not.toContain("LEAK");
    // The owner's log keeps the real paths.
    expect(JSON.stringify(logged()[1]?.calls)).toContain(smuggled);
  });

  it("names failed calls as usual when nothing is being withheld", async () => {
    const reply = await run(calling(["github_get_file", "github_typo"]), host({ github_typo: "schema_invalid: x" })).output;
    expect(reply.report.callsByTool).toEqual({ github_get_file: 1, github_typo: 1 });
  });

  it("hides unproven paths when the executor fails, since what was read is unknown", async () => {
    const broken: Executor = {
      name: "scripted",
      async execute(request) {
        await request.host.callTool(smuggled, {}).catch(() => undefined);
        throw new Error("crash");
      },
    };
    const reply = await run(broken, host({ [smuggled]: "policy_denied: no" }, confidential)).output;
    expect(reply.report.callsByTool).toEqual({ [UNNAMED_CALL]: 1 });
    expect(JSON.stringify(reply.report)).not.toContain("LEAK");
  });
});
