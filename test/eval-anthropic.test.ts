import type Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "vitest";
import { anthropicProvider, type AnthropicMessagesClient } from "../src/eval/providers/anthropic";
import type { TurnRequest } from "../src/eval/types";

/** A stand-in for the SDK client: no network, replays one response. */
function fakeClient(response: Partial<Anthropic.Message>): AnthropicMessagesClient & {
  sent: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    sent,
    messages: {
      create(params) {
        sent.push(params);
        return Promise.resolve(response as Anthropic.Message);
      },
    },
  };
}

const usage = { input_tokens: 120, output_tokens: 15 } as Anthropic.Usage;

const tools: TurnRequest["tools"] = [
  { name: "github_list_issues", description: "List issues.", inputSchema: { type: "object" } },
];

test("a tool-use response becomes tool calls, with usage as the API reported it", async () => {
  const content = [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "tool_use", id: "toolu_1", name: "github_list_issues", input: { state: "open" } },
  ] as Anthropic.ContentBlock[];
  const client = fakeClient({ content, stop_reason: "tool_use", usage });
  const provider = anthropicProvider({ model: "claude-opus-5-5", client });

  const turn = await provider.turn({
    system: "sys",
    messages: [{ role: "user", text: "q" }],
    tools,
  });

  expect(turn.toolCalls).toEqual([
    { id: "toolu_1", name: "github_list_issues", args: { state: "open" } },
  ]);
  expect(turn.usage).toEqual({ inputTokens: 120, outputTokens: 15 });
  expect(turn.raw).toBe(content);
  expect(client.sent[0]).toMatchObject({
    model: "claude-opus-5-5",
    system: "sys",
    messages: [{ role: "user", content: "q" }],
    tools: [{ name: "github_list_issues", input_schema: { type: "object" } }],
  });
});

test("the assistant turn is replayed unchanged and tool results share one user message", async () => {
  const raw = [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "tool_use", id: "a", name: "github_list_issues", input: {} },
    { type: "tool_use", id: "b", name: "github_list_issues", input: {} },
  ];
  const client = fakeClient({
    content: [{ type: "text", text: "3" }] as Anthropic.ContentBlock[],
    stop_reason: "end_turn",
    usage,
  });
  const provider = anthropicProvider({ model: "claude-opus-5-5", client });

  const turn = await provider.turn({
    system: "sys",
    tools,
    messages: [
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [], raw },
      { role: "tool", callId: "a", name: "github_list_issues", result: "[1]", isError: false },
      { role: "tool", callId: "b", name: "github_list_issues", result: "boom", isError: true },
    ],
  });

  expect(turn.text).toBe("3");
  expect(turn.toolCalls).toEqual([]);
  const sent = client.sent[0]?.messages;
  expect(sent).toHaveLength(3);
  expect(sent?.[1]).toEqual({ role: "assistant", content: raw });
  expect(sent?.[2]).toEqual({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: "[1]", is_error: false },
      { type: "tool_result", tool_use_id: "b", content: "boom", is_error: true },
    ],
  });
});

test("cached input tokens are counted as input", async () => {
  const client = fakeClient({
    content: [{ type: "text", text: "ok" }] as Anthropic.ContentBlock[],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 3000,
      output_tokens: 4,
    } as Anthropic.Usage,
  });
  const provider = anthropicProvider({ model: "claude-opus-5-5", client });
  const turn = await provider.turn({ system: "s", messages: [{ role: "user", text: "q" }], tools });

  expect(turn.usage).toEqual({ inputTokens: 3210, outputTokens: 4 });
});

test("a refusal or a cut-off answer is an error, never a silent empty answer", async () => {
  for (const stop_reason of ["refusal", "max_tokens"] as const) {
    const client = fakeClient({ content: [], stop_reason, usage });
    const provider = anthropicProvider({ model: "claude-opus-5-5", client });
    await expect(
      provider.turn({ system: "s", messages: [{ role: "user", text: "q" }], tools }),
    ).rejects.toThrow(`model stopped with ${stop_reason}`);
  }
});
