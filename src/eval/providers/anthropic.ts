/**
 * Anthropic adapter for the eval harness. The harness owns the loop so that every
 * provider is measured the same way, turn by turn; this file only translates.
 *
 * Refusal fallbacks are deliberately not enabled: a fallback would answer with a
 * different model and the measurement would no longer be of the model named.
 * A refusal is recorded as a failed run instead.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ModelOutputError } from "../types";
import type { Message, ModelProvider, ModelTurn, ToolCall, TurnRequest } from "../types";

/** The part of the SDK client this adapter uses. Narrow so tests can supply a fake. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  readonly model: string;
  /** Defaults to a client that reads credentials from the environment. */
  readonly client?: AnthropicMessagesClient;
  readonly maxTokens?: number;
}

function toMessageParams(messages: readonly Message[]): Anthropic.MessageParam[] {
  const params: Anthropic.MessageParam[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];

  const flush = () => {
    if (pendingResults.length > 0) {
      // Every result for one assistant turn goes back in a single user message.
      params.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: message.callId,
        content: message.result,
        is_error: message.isError,
      });
      continue;
    }
    flush();
    if (message.role === "user") {
      params.push({ role: "user", content: message.text });
    } else {
      // Replay the content exactly as the API returned it, thinking blocks included.
      params.push({
        role: "assistant",
        content: message.raw as Anthropic.ContentBlockParam[],
      });
    }
  }
  flush();
  return params;
}

export function anthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const client = options.client ?? new Anthropic();
  const maxTokens = options.maxTokens ?? 16_000;

  return {
    provider: "anthropic",
    model: options.model,
    async turn(request: TurnRequest): Promise<ModelTurn> {
      const response = await client.messages.create({
        model: options.model,
        max_tokens: maxTokens,
        system: request.system,
        messages: toMessageParams(request.messages),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
      });

      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        throw new ModelOutputError(`model stopped with ${response.stop_reason}`);
      }

      const toolCalls: ToolCall[] = [];
      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, name: block.name, args: block.input });
        }
      }

      const usage = response.usage;
      return {
        text,
        toolCalls,
        raw: response.content,
        usage: {
          // Cached tokens are still input the model read, so they count.
          inputTokens:
            usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        },
      };
    },
  };
}
