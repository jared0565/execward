import { describe, expect, it } from "vitest";
import { APP_SYSTEM_PROMPT, CODE_TOOL_DEFINITION, runAppTask, type AppDeps } from "../src/app/agent";
import { reconcile } from "../src/app/reconcile";
import { memoryAuditStore } from "../src/audit/log";
import { memoryProjectStore } from "../src/broker/exposure";
import { memoryPolicyStore } from "../src/broker/policy-store";
import { memoryQuotaStore } from "../src/broker/quotas";
import { UNTRUSTED_OPEN } from "../src/code-tool/present";
import type { RunReport } from "../src/contracts/code-tool";
import { ModelOutputError, type ModelProvider, type ModelTurn, type ToolBackend, type TurnRequest } from "../src/eval/types";
import type { Executor } from "../src/executor";
import { INITIAL_CONTROL_STATE, memoryControlStore } from "../src/console/control";
import { memoryMeterSink, meter } from "../src/meter/meter";
import { codeToolService } from "../src/service";
import { record } from "./fixtures/policy";

const USAGE = { inputTokens: 100, outputTokens: 20 };
const say = (text: string): ModelTurn => ({ text, toolCalls: [], usage: USAGE });
const call = (name: string, args: unknown, id = "call-1"): ModelTurn => ({ text: "", toolCalls: [{ id, name, args }], usage: USAGE });

/** A stand-in model: plays the given turns in order and records what it was offered. */
function scriptedModel(turns: readonly (ModelTurn | Error)[]): ModelProvider & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  let next = 0;
  return {
    provider: "scripted",
    model: "stand-in",
    requests,
    async turn(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const turn = turns[next++] ?? say("out of turns");
      if (turn instanceof Error) throw turn;
      return turn;
    },
  };
}

/** The whole service, in memory. The stand-in executor lists issues and returns how many there are. */
function app(turns: readonly (ModelTurn | Error)[], options: { codeMode?: () => boolean; executor?: Executor; maxTurns?: number } = {}) {
  const issues = [{ number: 1 }, { number: 2 }, { number: 3 }];
  const upstreamCalls: string[] = [];
  const audit = memoryAuditStore();
  const scripts: string[] = [];
  let run = 0;
  const counting: Executor = {
    name: "scripted",
    async execute(request) {
      scripts.push(request.script);
      const found = (await request.host.callTool("github_list_issues", {})) as unknown[];
      return { status: "completed", result: { openIssues: found.length }, logs: [], truncated: false };
    },
  };
  const codeTool = codeToolService({
    executor: options.executor ?? counting,
    policy: memoryPolicyStore([record("list_issues", { dataClass: "internal" })]),
    projects: memoryProjectStore([{ project: "work", dataClass: "internal" }]),
    quotas: memoryQuotaStore(),
    audit,
    upstream: async ({ record: called }) => (upstreamCalls.push(called.tool), issues),
    definitionFor: async () => ({ description: "t", inputSchema: { type: "object", additionalProperties: true } }),
    docsFor: async () => undefined,
    meter: meter({ level: "off", sink: memoryMeterSink() }),
    control: memoryControlStore({ ...INITIAL_CONTROL_STATE, codeMode: true }),
    now: () => 1_800_000_000_000,
    newRunId: () => `run-${++run}`,
  });
  const directCalls: { name: string; args: unknown }[] = [];
  const direct: ToolBackend = {
    definitions: [{ name: "github_list_issues", description: "Lists issues.", inputSchema: { type: "object" } }],
    async call(name, args) {
      directCalls.push({ name, args });
      if (name !== "github_list_issues") throw new Error(`unknown tool ${name}`);
      return issues;
    },
  };
  const model = scriptedModel(turns);
  const deps: AppDeps = { model, codeTool, direct, codeMode: options.codeMode ?? (() => true), project: "work", providerRoute: "anthropic_api_commercial", ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }) };
  const kinds = () => audit.entries.map((entry) => entry.kind);
  return { run: (request = "How many open issues are there?") => runAppTask(request, deps), model, upstreamCalls, directCalls, scripts, kinds, audit };
}

describe("the test app with Code Mode on (FR-9)", () => {
  it("offers the model exactly one tool, the code tool, and no catalog", async () => {
    const { run, model } = app([say("none")]);
    await run();
    expect(model.requests[0]?.tools).toEqual([CODE_TOOL_DEFINITION]);
    expect(model.requests[0]?.system).toBe(APP_SYSTEM_PROMPT);
    expect(JSON.stringify(model.requests[0])).not.toContain("github_list_issues");
    // The project is the app's to set, so the model is not offered it as an argument.
    expect(Object.keys(CODE_TOOL_DEFINITION.inputSchema.properties as object)).toEqual(["script", "intent", "criteria"]);
  });

  it("runs the model's script through the whole service and gives the result back as untrusted data", async () => {
    const { run, model, upstreamCalls, scripts, kinds } = app([call("code", { script: "return (await tools.github_list_issues({})).length;", intent: "count issues" }), say("There are 3 open issues.")]);
    const result = await run();
    expect(result).toMatchObject({ answer: "There are 3 open issues.", stopped: "answered", turns: 2, inputTokens: 200, outputTokens: 40, directCalls: 0 });
    expect(scripts).toEqual(["return (await tools.github_list_issues({})).length;"]);
    expect(upstreamCalls).toEqual(["list_issues"]);
    expect(kinds()).toEqual(["run_started", "run_finished"]);
    expect(result.reports).toMatchObject([{ runId: "run-1", callsByTool: { github_list_issues: 1 }, recordsRead: 3, verification: "unreviewed" }]);

    const toolMessage = model.requests[1]?.messages.at(-1);
    expect(toolMessage).toMatchObject({ role: "tool", callId: "call-1", name: "code", isError: false });
    const shown = toolMessage?.role === "tool" ? toolMessage.result : "";
    expect(shown).toContain(UNTRUSTED_OPEN);
    expect(shown).toContain('"openIssues": 3');
  });

  it("sets the project itself, whatever the model sends", async () => {
    const { run, audit } = app([call("code", { script: "return 1;", project: "client", sudo: true }), say("done")]);
    const result = await run();
    expect(result.reports.length).toBe(1);
    expect(audit.entries.map((entry) => entry.project)).toEqual(["work", "work"]);
  });

  it("does not let the model call a wrapped tool directly", async () => {
    const { run, model, directCalls } = app([call("github_list_issues", {}), say("ok")]);
    const result = await run();
    expect(directCalls).toEqual([]);
    expect(result.directCalls).toBe(0);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true, result: '"github_list_issues" is not offered here. Use the code tool.' });
  });

  it("returns a failed run to the model as an error it can fix", async () => {
    let attempt = 0;
    const flaky: Executor = {
      name: "scripted",
      execute: async () =>
        attempt++ === 0 ? { status: "failed", failure: { kind: "script_error", message: "x is not defined", line: 1 }, logs: [] } : { status: "completed", result: 3, logs: [], truncated: false },
    };
    const { run, model } = app([call("code", { script: "const x = null; return x.y;" }), call("code", { script: "return 3;" }, "call-2"), say("3")], { executor: flaky });
    const result = await run();
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true });
    expect(result.reports.map((report) => report.retries)).toEqual([0, 1]);
    expect(result).toMatchObject({ answer: "3", escalations: [] });
  });

  it("keeps one retry count for the whole request, and escalates when it is used up", async () => {
    const broken: Executor = { name: "scripted", execute: async () => ({ status: "failed", failure: { kind: "script_error", message: "x is not defined" }, logs: [] }) };
    const turns = [1, 2, 3, 4].map((n) => call("code", { script: "const x = null; return x.y;" }, `call-${n}`));
    const { run, kinds } = app([...turns, say("I could not do it.")], { executor: broken });
    const result = await run();
    expect(result.reports.length).toBe(4);
    expect(result.escalations).toMatchObject([{ reason: "retries_exhausted", runId: "run-3" }]);
    // The fourth call was refused without running.
    expect(kinds().at(-1)).toBe("run_refused");
    expect(result.reports[3]?.errors[0]).toMatchObject({ code: "quota_exceeded" });
  });

  it("starts a fresh retry count for the next request", async () => {
    const broken: Executor = { name: "scripted", execute: async () => ({ status: "failed", failure: { kind: "script_error", message: "x" }, logs: [] }) };
    const first = await app([call("code", { script: "const x = null; return x.y;" }), say("failed")], { executor: broken }).run();
    const second = await app([call("code", { script: "const x = null; return x.y;" }), say("failed")], { executor: broken }).run();
    expect([first.reports[0]?.retries, second.reports[0]?.retries]).toEqual([0, 0]);
  });
});

describe("the test app with Code Mode off (FR-16)", () => {
  it("removes the code tool and offers the wrapped tools for direct calls", async () => {
    const { run, model, directCalls, upstreamCalls, kinds } = app([call("github_list_issues", { state: "open" }), say("There are 3 open issues.")], { codeMode: () => false });
    const result = await run();
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(["github_list_issues"]);
    expect(directCalls).toEqual([{ name: "github_list_issues", args: { state: "open" } }]);
    expect(result).toMatchObject({ answer: "There are 3 open issues.", directCalls: 1, reports: [] });
    // Nothing went through the code tool.
    expect(upstreamCalls).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: false, result: '[{"number":1},{"number":2},{"number":3}]' });
  });

  it("refuses a call to the code tool", async () => {
    const { run, model, scripts } = app([call("code", { script: "return 1;" }), say("ok")], { codeMode: () => false });
    await run();
    expect(scripts).toEqual([]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true, result: "code_mode_off: Code Mode is switched off. Call the tools directly." });
  });

  it("gives a failed direct call back to the model as an error", async () => {
    const { run, model } = app([call("github_delete_everything", {}), say("ok")], { codeMode: () => false });
    await run();
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true, result: "unknown tool github_delete_everything" });
  });

  it("takes a switch made mid-task at the next turn", async () => {
    let on = true;
    const { run, model } = app([call("code", { script: "return 1;" }), call("github_list_issues", {}, "call-2"), say("3")], { codeMode: () => on });
    const pending = run();
    // Turn 1 is offered `code`; the switch goes off before turn 2 is asked for.
    on = false;
    const result = await pending;
    expect(model.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([["code"], ["github_list_issues"], ["github_list_issues"]]);
    expect(result.directCalls).toBe(1);
  });
});

describe("how a task ends", () => {
  it("stops at the turn limit", async () => {
    const turns = Array.from({ length: 10 }, (_, n) => call("code", { script: "return 1;" }, `call-${n}`));
    const result = await app(turns, { maxTurns: 3 }).run();
    expect(result).toMatchObject({ stopped: "turn_limit", answer: "", turns: 3 });
  });

  it("reports a model that stopped, and a provider that failed, without repeating model output as an answer", async () => {
    expect(await app([new ModelOutputError("refused")]).run()).toMatchObject({ stopped: "model_error", answer: "", detail: "the model stopped: refused" });
    expect(await app([new Error("429 rate limited")]).run()).toMatchObject({ stopped: "model_error", detail: "the provider failed: 429 rate limited" });
  });
});

describe("the model's summary is checked against what happened (FR-39)", () => {
  const REPORT: RunReport = {
    runId: "run-1",
    scriptHash: "0".repeat(64),
    callsByTool: { github_list_issues: 2 },
    recordsRead: 41,
    recordsWritten: 0,
    errors: [],
    retries: 0,
    assertions: { passed: 1, failed: 0 },
    sideEffects: [],
    verification: "unreviewed",
    durationMs: 12,
  };
  const check = (summary: string, returned: string[] = ['{"openIssues": 41, "oldest": 1204}'], request = "How many open issues are there in the last 30 days?") =>
    reconcile({ summary, request, returned, reports: [REPORT] });

  it("passes a summary whose figures were all returned", () => {
    expect(check("There are 41 open issues; the oldest is #1,204.")).toEqual({ figures: 2, unsupported: [], flagged: false });
  });

  it("flags a summary with a wrong number", () => {
    expect(check("There are 47 open issues.")).toEqual({ figures: 1, unsupported: ["47"], flagged: true });
  });

  it("accepts figures from the request and from the run report", () => {
    expect(check("In the last 30 days: 41 issues, from 2 calls that read 41 records.").flagged).toBe(false);
  });

  it("does not treat part of a returned number as support", () => {
    // 120 is not 1204, and 4 is not 41.
    expect(check("120 issues, 4 of them old").unsupported).toEqual(["120", "4"]);
  });

  it("reads decimals, negatives and separators as written", () => {
    const result = check("Up 3.5% to 12,500, a change of -2.", ['{"growth": 3.5, "total": 12500, "delta": -2}']);
    expect(result).toEqual({ figures: 3, unsupported: [], flagged: false });
    expect(check("Up 3.6%", ['{"growth": 3.5}']).unsupported).toEqual(["3.6"]);
  });

  it("flags a figure the model worked out itself", () => {
    // 41 + 1204. It may be right; it cannot be traced.
    expect(check("1245 in total").unsupported).toEqual(["1245"]);
  });

  it("ignores digits inside words and identifiers", () => {
    expect(check("See run-1 and the sha256 of v2.").figures).toBe(0);
  });

  it("has nothing to say about a summary with no figures", () => {
    expect(check("The repository has open issues.")).toEqual({ figures: 0, unsupported: [], flagged: false });
  });

  it("flags a wrong number in a real task, end to end", async () => {
    const honest = await app([call("code", { script: "return 1;" }), say("There are 3 open issues.")]).run();
    expect(honest.reconciliation).toEqual({ figures: 1, unsupported: [], flagged: false });
    const wrong = await app([call("code", { script: "return 1;" }), say("There are 30 open issues.")]).run();
    expect(wrong.reconciliation).toEqual({ figures: 1, unsupported: ["30"], flagged: true });
    // The answer is still returned; the flag travels with it.
    expect(wrong.answer).toBe("There are 30 open issues.");
  });

  it("checks direct-call results the same way", async () => {
    const wrong = await app([call("github_list_issues", {}), say("There are 9 open issues.")], { codeMode: () => false }).run();
    expect(wrong.reconciliation.unsupported).toEqual(["9"]);
  });
});
