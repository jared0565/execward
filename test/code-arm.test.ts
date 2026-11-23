import { describe, expect, it } from "vitest";
import { CODE_TOOL_DEFINITION } from "../src/app/agent";
import { UNTRUSTED_OPEN } from "../src/code-tool/present";
import type { CodeToolOutput } from "../src/contracts/code-tool";
import { codeBackend } from "../src/eval/arms/code";
import { runTask } from "../src/eval/harness";
import type { EvalTask, ModelProvider, ModelTurn } from "../src/eval/types";

const report = (overrides: Partial<CodeToolOutput["report"]> = {}): CodeToolOutput["report"] => ({
  runId: "run-1",
  scriptHash: "a".repeat(64),
  callsByTool: { github_list_issues: 2 },
  recordsRead: 2,
  recordsWritten: 0,
  errors: [],
  retries: 0,
  assertions: { passed: 0, failed: 0 },
  sideEffects: [],
  verification: "unreviewed",
  durationMs: 5,
  ...overrides,
});
const completed = (result: unknown): CodeToolOutput => ({ status: "completed", result, logs: [], truncated: false, report: report() });
const failedWith = (code: "script_error" | "policy_denied"): CodeToolOutput => ({ status: "error", error: { code, message: "it failed" }, report: report({ callsByTool: {}, errors: [{ code, message: "it failed" }] }) });

describe("the Code Mode arm of the eval (task 1.9.5)", () => {
  it("offers the one tool the test app offers, and nothing else", () => {
    expect(codeBackend(async () => completed(1)).definitions).toEqual([CODE_TOOL_DEFINITION]);
  });

  it("passes the script on with the project set by the harness, never by the model", async () => {
    const seen: unknown[] = [];
    const backend = codeBackend(async (input) => {
      seen.push(input);
      return completed(3);
    });
    await backend.call("code", { script: "return 3;", project: "somewhere-else", intent: "count", extra: true });
    expect(seen).toEqual([{ script: "return 3;", project: "eval", intent: "count" }]);
  });

  it("returns a result as the test app presents it: marked as untrusted data", async () => {
    const backend = codeBackend(async () => completed({ open: 3 }));
    const shown = await backend.call("code", { script: "return 1;" });
    expect(typeof shown).toBe("string");
    expect(String(shown)).toContain(UNTRUSTED_OPEN);
    expect(String(shown)).toContain('"open": 3');
    expect(backend.outcomes).toEqual([{ status: "completed", calls: 2, truncated: false }]);
  });

  it("reports a failed run as a failed tool call", async () => {
    const backend = codeBackend(async () => failedWith("script_error"));
    await expect(backend.call("code", { script: "x" })).rejects.toThrow("script_error");
    expect(backend.outcomes).toEqual([{ status: "error", errorCode: "script_error", errorMessage: "it failed", calls: 0, truncated: false }]);
  });

  it("stops running scripts after the third failed run in one task, and after a security refusal", async () => {
    let ran = 0;
    const failing = codeBackend(async () => {
      ran += 1;
      return failedWith("script_error");
    });
    for (let attempt = 0; attempt < 5; attempt++) await failing.call("code", { script: "x" }).catch(() => undefined);
    expect(ran).toBe(3);
    expect(failing.outcomes.map((outcome) => outcome.status)).toEqual(["error", "error", "error", "refused", "refused"]);

    ran = 0;
    const denied = codeBackend(async () => {
      ran += 1;
      return failedWith("policy_denied");
    });
    for (let attempt = 0; attempt < 3; attempt++) await denied.call("code", { script: "x" }).catch(() => undefined);
    expect(ran).toBe(1);
  });

  it("refuses a reply that does not match the output contract, and any other tool name", async () => {
    await expect(codeBackend(async () => ({ status: "completed" })).call("code", { script: "x" })).rejects.toThrow();
    await expect(codeBackend(async () => completed(1)).call("github_list_issues", {})).rejects.toThrow("is not offered here");
  });

  it("runs a task end to end in the harness, and the result text reaches the model unquoted", async () => {
    const turns: ModelTurn[] = [
      { text: "", toolCalls: [{ id: "c1", name: "code", args: { script: "return 3;" } }], usage: { inputTokens: 10, outputTokens: 5 } },
      { text: "3", toolCalls: [], usage: { inputTokens: 12, outputTokens: 1 } },
    ];
    const requests: string[] = [];
    const model: ModelProvider = {
      provider: "test",
      model: "stand-in",
      async turn(request) {
        const last = request.messages.at(-1);
        if (last?.role === "tool") requests.push(last.result);
        return turns.shift() as ModelTurn;
      },
    };
    const task: EvalTask = { id: "t", type: "bounded_tool_heavy", prompt: "How many?", check: (answer) => answer.trim() === "3" } as EvalTask;
    const record = await runTask(task, model, codeBackend(async () => completed({ note: 'a "quoted" word' })), { arm: "code" });
    expect(record).toMatchObject({ success: true, arm: "code", toolCalls: 1, toolErrors: 0, inputTokens: 22 });
    expect(requests[0]?.startsWith('"')).toBe(false);
    expect(requests[0]).toContain(UNTRUSTED_OPEN);
  });
});
