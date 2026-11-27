import { describe, expect, it } from "vitest";
import type { ExecutionLimits } from "../src/executor";
import { capLogs, cutToBytes, interpretReport, platformLimit } from "../src/executor/outcome";

describe("telling the platform's limit messages from any other failure", () => {
  it("takes the platform's own two messages, whole", () => {
    expect(platformLimit("Worker exceeded CPU time limit.")).toBe("cpu");
    expect(platformLimit("Worker exceeded memory limit.")).toBe("memory");
  });

  it.each([
    "the tool said: Worker exceeded CPU time limit.",
    "Worker exceeded CPU time limit. Also, something else broke",
    "internal error\nWorker exceeded memory limit.",
    "worker exceeded memory limit.",
    "",
  ])("does not take %j for a limit: it only contains the words, or is something else", (message) => {
    expect(platformLimit(message)).toBeUndefined();
  });
});
import { buildSandboxModules, RUNNER_MODULE, SCRIPT_MODULE } from "../src/executor/sandbox-modules";

const LIMITS: ExecutionLimits = { cpuMs: 50, wallClockMs: 1_000, maxHostCalls: 10, maxResultBytes: 64 };

describe("reading the sandbox's report as untrusted input", () => {
  it.each([
    ["nothing", undefined],
    ["a string", "completed"],
    ["an array", []],
    ["an unknown status", { status: "paused" }],
    ["a completed report with no result", { status: "completed" }],
    ["a result that is not text", { status: "completed", resultJson: { a: 1 } }],
    ["a result that is not JSON", { status: "completed", resultJson: "{oops" }],
  ])("treats %s as a sandbox fault", (_label, report) => {
    expect(interpretReport(report, LIMITS)).toMatchObject({ status: "failed", failure: { kind: "sandbox_fault" } });
  });

  it("accepts only the two failure kinds a script can cause", () => {
    const outcome = interpretReport({ status: "failed", kind: "quota_exceeded", message: "x", line: -4, globalsLeft: [] }, LIMITS);
    expect(outcome).toEqual({ status: "failed", failure: { kind: "script_error", message: "x" }, logs: [] });
  });

  it("drops log entries that are not text", () => {
    expect(capLogs(["a", 7, { b: 1 }, "c"], 100)).toEqual(["a", "c"]);
    expect(capLogs("not a list", 100)).toEqual([]);
  });

  it("cuts on a character boundary", () => {
    expect(cutToBytes("ééé", 3)).toBe("é");
    expect(cutToBytes("abc", 10)).toBe("abc");
  });

  it("cuts an oversized result and marks it", () => {
    const outcome = interpretReport({ status: "completed", resultJson: JSON.stringify("x".repeat(500)), logs: [], globalsLeft: [] }, LIMITS);
    expect(outcome).toMatchObject({ status: "completed", truncated: true });
  });
});

describe("building the modules a Dynamic Worker is loaded with", () => {
  it("wraps the script and adds the runner", () => {
    const built = buildSandboxModules("return 1;");
    if (!built.ok) throw new Error(built.message);
    expect(Object.keys(built.modules).sort()).toEqual([RUNNER_MODULE, SCRIPT_MODULE].sort());
    expect(built.modules[SCRIPT_MODULE]).toContain("\nreturn 1;\n");
  });

  it.each([
    ["closes the wrapper", "return 1; }\nfetch('x');\nasync function y() {"],
    ["is not JavaScript", "const = ;"],
    ["has an import", `import x from "y";`],
    ["has an export", "export const a = 1;"],
  ])("refuses a script that %s", (_label, script) => {
    expect(buildSandboxModules(script).ok).toBe(false);
  });

  it("treats a global the runner could not hide, or a report with no list of them, as a fault (review finding F6)", () => {
    const done = { status: "completed", resultJson: "1", logs: ["a line"] };
    expect(interpretReport({ ...done, globalsLeft: [] }, LIMITS)).toMatchObject({ status: "completed", result: 1 });
    const left = interpretReport({ ...done, globalsLeft: ["fetch"] }, LIMITS);
    expect(left).toMatchObject({ status: "failed", failure: { kind: "sandbox_fault", detail: "fetch" }, logs: [] });
    // The caller's message names nothing from the report.
    expect(left.status === "failed" && left.failure.message).not.toContain("fetch");
    expect(interpretReport(done, LIMITS)).toMatchObject({ status: "failed", failure: { kind: "sandbox_fault" } });
    expect(interpretReport({ ...done, globalsLeft: "none" }, LIMITS)).toMatchObject({ status: "failed", failure: { kind: "sandbox_fault" } });
  });
});
