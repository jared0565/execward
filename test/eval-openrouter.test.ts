import type OpenAI from "openai";
import { expect, test } from "vitest";
import { openRouterProvider, type ChatCompletionsClient } from "../src/eval/providers/openrouter";
import { ModelOutputError, type TurnRequest } from "../src/eval/types";

type Params = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

/** A stand-in for the SDK client: no network, replays one response. */
function fakeClient(response: unknown): ChatCompletionsClient & { sent: Params[] } {
  const sent: Params[] = [];
  return {
    sent,
    chat: {
      completions: {
        create(params) {
          sent.push(params);
          return Promise.resolve(response as OpenAI.Chat.ChatCompletion);
        },
      },
    },
  };
}

const tools: TurnRequest["tools"] = [
  { name: "github_list_issues", description: "List issues.", inputSchema: { type: "object" } },
];
const request: TurnRequest = { system: "sys", messages: [{ role: "user", text: "q" }], tools };
const usage = { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, cost: 0.00012 };

function provider(client: ChatCompletionsClient) {
  return openRouterProvider({ model: "anthropic/claude-haiku-5.5", upstream: "anthropic", client });
}

test("a tool-call response becomes tool calls, with usage and cost as reported", async () => {
  const message = {
    role: "assistant",
    content: null,
    reasoning_details: [{ type: "reasoning.encrypted", data: "x", index: 0 }],
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "github_list_issues", arguments: '{"state":"open"}' },
      },
    ],
  };
  const client = fakeClient({ choices: [{ finish_reason: "tool_calls", message }], usage });

  const turn = await provider(client).turn(request);

  expect(turn.toolCalls).toEqual([
    { id: "call_1", name: "github_list_issues", args: { state: "open" } },
  ]);
  expect(turn.text).toBe("");
  expect(turn.usage).toEqual({ inputTokens: 200, outputTokens: 30, reportedCostUsd: 0.00012 });
  expect(turn.raw).toBe(message);
  expect(client.sent[0]).toMatchObject({
    model: "anthropic/claude-haiku-5.5",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
    ],
    tools: [{ type: "function", function: { name: "github_list_issues" } }],
    provider: { only: ["anthropic"], allow_fallbacks: false, data_collection: "deny" },
  });
});

test("the assistant message is replayed unchanged and a failed tool says so", async () => {
  const raw = { role: "assistant", content: null, reasoning_details: [{ index: 0 }] };
  const client = fakeClient({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "42" } }],
    usage,
  });

  const turn = await provider(client).turn({
    ...request,
    messages: [
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [], raw },
      { role: "tool", callId: "a", name: "t", result: "ok", isError: false },
      { role: "tool", callId: "b", name: "t", result: "boom", isError: true },
    ],
  });

  expect(turn.text).toBe("42");
  const sent = client.sent[0]?.messages ?? [];
  expect(sent[2]).toBe(raw);
  expect(sent[3]).toEqual({ role: "tool", tool_call_id: "a", content: "ok" });
  expect(sent[4]).toEqual({ role: "tool", tool_call_id: "b", content: "Error: boom" });
});

test("a cut-off, a refusal and bad tool arguments are the model's failure", async () => {
  const cutOff = fakeClient({
    choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }],
    usage,
  });
  await expect(provider(cutOff).turn(request)).rejects.toBeInstanceOf(ModelOutputError);

  const refusal = fakeClient({
    choices: [{ finish_reason: "stop", message: { role: "assistant", refusal: "no" } }],
    usage,
  });
  await expect(provider(refusal).turn(request)).rejects.toBeInstanceOf(ModelOutputError);

  const badArgs = fakeClient({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{" } }],
        },
      },
    ],
    usage,
  });
  await expect(provider(badArgs).turn(request)).rejects.toBeInstanceOf(ModelOutputError);
});

test("an error body in place of a completion is the route's failure", async () => {
  const client = fakeClient({ error: { message: "upstream unavailable" } });
  const failure = provider(client).turn(request);
  await expect(failure).rejects.toThrow("upstream unavailable");
  await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
});
