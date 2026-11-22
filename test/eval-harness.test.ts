import { expect, test } from "vitest";
import { runTask } from "../src/eval/harness";
import type {
  EvalTask,
  ModelProvider,
  ModelTurn,
  ToolBackend,
  TurnRequest,
} from "../src/eval/types";

/** A provider that replays fixed turns and remembers what it was sent. */
function scripted(turns: readonly (ModelTurn | Error)[]): ModelProvider & {
  requests: TurnRequest[];
} {
  const requests: TurnRequest[] = [];
  let index = 0;
  return {
    provider: "scripted",
    model: "scripted-1",
    requests,
    turn(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const next = turns[index++];
      if (next === undefined) return Promise.reject(new Error("script ran out"));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  };
}

const backend: ToolBackend = {
  definitions: [
    {
      name: "github_list_issues",
      description: "List issues.",
      inputSchema: { type: "object", properties: { state: { type: "string" } } },
    },
  ],
  call(name, args) {
    if (name !== "github_list_issues") return Promise.reject(new Error(`unknown tool ${name}`));
    return Promise.resolve({ args, issues: [{ number: 1 }, { number: 2 }, { number: 3 }] });
  },
};

const task: EvalTask = {
  id: "count-open-issues",
  type: "bounded_tool_heavy",
  prompt: "How many open issues are there?",
  check: (answer) => /\b3\b/.test(answer),
};

const callIssues: ModelTurn = {
  text: "",
  toolCalls: [{ id: "c1", name: "github_list_issues", args: { state: "open" } }],
  usage: { inputTokens: 100, outputTokens: 10 },
};

function clock(): () => number {
  let t = 1_000;
  return () => (t += 250);
}

test("a correct answer after one tool call is a success, with provider usage summed", async () => {
  const provider = scripted([
    callIssues,
    { text: "3", toolCalls: [], usage: { inputTokens: 160, outputTokens: 2 } },
  ]);
  const record = await runTask(task, provider, backend, { arm: "direct", now: clock() });

  expect(record).toEqual({
    taskId: "count-open-issues",
    taskType: "bounded_tool_heavy",
    arm: "direct",
    provider: "scripted",
    model: "scripted-1",
    success: true,
    failureCause: null,
    failureDetail: null,
    turns: 2,
    inputTokens: 260,
    outputTokens: 12,
    toolCalls: 1,
    toolErrors: 0,
    wallClockMs: 250,
  });
});

test("the tool result is sent back to the model on the next turn", async () => {
  const provider = scripted([
    callIssues,
    { text: "3", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  await runTask(task, provider, backend, { arm: "direct" });

  const second = provider.requests[1];
  expect(second?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  const toolMessage = second?.messages[2];
  expect(toolMessage).toMatchObject({ role: "tool", callId: "c1", isError: false });
  expect(toolMessage?.role === "tool" && toolMessage.result).toContain('"number":3');
  expect(second?.tools).toBe(backend.definitions);
});

test("a wrong answer and an empty answer are different failures", async () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  const wrong = await runTask(task, scripted([{ text: "7", toolCalls: [], usage }]), backend, {
    arm: "direct",
  });
  const empty = await runTask(task, scripted([{ text: "  ", toolCalls: [], usage }]), backend, {
    arm: "direct",
  });
  expect([wrong.success, wrong.failureCause]).toEqual([false, "wrong_answer"]);
  expect([empty.success, empty.failureCause]).toEqual([false, "no_answer"]);
});

test("a failing tool is reported to the model and counted, and the run goes on", async () => {
  const provider = scripted([
    { ...callIssues, toolCalls: [{ id: "c1", name: "github_delete_repo", args: {} }] },
    { text: "3", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const record = await runTask(task, provider, backend, { arm: "direct" });

  expect(record.toolErrors).toBe(1);
  expect(record.success).toBe(true);
  expect(provider.requests[1]?.messages[2]).toMatchObject({
    role: "tool",
    isError: true,
    result: "unknown tool github_delete_repo",
  });
});

test("a model that never stops calling tools ends at the turn limit", async () => {
  const provider = scripted([callIssues, callIssues, callIssues, callIssues]);
  const record = await runTask(task, provider, backend, { arm: "direct", maxTurns: 3 });

  expect(record.failureCause).toBe("turn_limit");
  expect(record.turns).toBe(3);
  expect(record.inputTokens).toBe(300);
});

test("a provider error ends the run and keeps the usage already recorded", async () => {
  const provider = scripted([callIssues, new Error("HTTP 529 overloaded")]);
  const record = await runTask(task, provider, backend, { arm: "direct" });

  expect(record.failureCause).toBe("provider_error");
  expect(record.failureDetail).toBe("HTTP 529 overloaded");
  expect(record.turns).toBe(1);
  expect(record.inputTokens).toBe(100);
});
