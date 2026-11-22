import type OpenAI from "openai";
import { expect, test } from "vitest";
import { openAIProvider, type OpenAIResponsesClient } from "../src/eval/providers/openai";
import { ModelOutputError, type TurnRequest } from "../src/eval/types";

type Params = OpenAI.Responses.ResponseCreateParamsNonStreaming;

/** A stand-in for the SDK client: no network, replays one response. */
function fakeClient(response: unknown): OpenAIResponsesClient & { sent: Params[] } {
  const sent: Params[] = [];
  return {
    sent,
    responses: {
      create(params) {
        sent.push(params);
        return Promise.resolve(response as OpenAI.Responses.Response);
      },
    },
  };
}

const tools: TurnRequest["tools"] = [
  { name: "github_list_issues", description: "List issues.", inputSchema: { type: "object" } },
];
const request: TurnRequest = { system: "sys", messages: [{ role: "user", text: "q" }], tools };
const usage = { input_tokens: 150, output_tokens: 40, total_tokens: 190 };

test("a function call becomes a tool call and the output items are kept for replay", async () => {
  const output = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "x" },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "github_list_issues",
      arguments: '{"state":"open"}',
    },
  ];
  const client = fakeClient({ status: "completed", output, usage });

  const turn = await openAIProvider({ model: "gpt-6-luna", client }).turn(request);

  expect(turn.toolCalls).toEqual([
    { id: "call_1", name: "github_list_issues", args: { state: "open" } },
  ]);
  expect(turn.usage).toEqual({ inputTokens: 150, outputTokens: 40 });
  expect(turn.raw).toMatchObject([
    { type: "reasoning", encrypted_content: "x" },
    { type: "function_call", call_id: "call_1" },
  ]);
  expect(client.sent[0]).toMatchObject({
    model: "gpt-6-luna",
    instructions: "sys",
    store: false,
    input: [{ role: "user", content: "q" }],
    tools: [{ type: "function", name: "github_list_issues", strict: false }],
  });
});

test("earlier output items are replayed in order, followed by the tool results", async () => {
  const raw = [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "function_call", call_id: "a", name: "t", arguments: "{}" },
  ];
  const output = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "42" }] },
  ];
  const client = fakeClient({ status: "completed", output, usage });

  const turn = await openAIProvider({ model: "gpt-6-luna", client }).turn({
    ...request,
    messages: [
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [], raw },
      { role: "tool", callId: "a", name: "t", result: "boom", isError: true },
    ],
  });

  expect(turn.text).toBe("42");
  expect(client.sent[0]?.input).toEqual([
    { role: "user", content: "q" },
    ...raw,
    { type: "function_call_output", call_id: "a", output: "Error: boom" },
  ]);
});

test("a cut-off and a refusal are the model's failure; a failed response is the route's", async () => {
  const cutOff = fakeClient({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [],
    usage,
  });
  await expect(openAIProvider({ model: "m", client: cutOff }).turn(request)).rejects.toThrow(
    ModelOutputError,
  );

  const refusal = fakeClient({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }],
    usage,
  });
  await expect(openAIProvider({ model: "m", client: refusal }).turn(request)).rejects.toThrow(
    ModelOutputError,
  );

  const failed = fakeClient({ status: "failed", error: { message: "server error" }, output: [] });
  const failure = openAIProvider({ model: "m", client: failed }).turn(request);
  await expect(failure).rejects.toThrow("server error");
  await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
});
