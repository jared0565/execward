/**
 * OpenRouter adapter for the eval harness: the default route to every model.
 * OpenRouter speaks the Chat Completions shape, so the OpenAI SDK is used with
 * OpenRouter's base URL. The harness owns the loop; this file only translates.
 *
 * Each request is pinned to one upstream host with no fallback to another, so a
 * run measures one model served one way. When that host fails the request fails,
 * and the runner retries the whole run on the direct provider instead.
 */
import OpenAI from "openai";
import { ModelOutputError } from "../types";
import type { Message, ModelProvider, ModelTurn, ToolCall, TurnRequest } from "../types";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type CreateParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
type MessageParam = OpenAI.Chat.ChatCompletionMessageParam;

/** The part of the SDK client this adapter uses. Narrow so tests can supply a fake. */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(params: CreateParams): Promise<OpenAI.Chat.ChatCompletion>;
    };
  };
}

export interface OpenRouterProviderOptions {
  /** OpenRouter model id, for example `anthropic/claude-haiku-5.5`. */
  readonly model: string;
  /** OpenRouter slug of the one upstream host allowed, for example `anthropic`. */
  readonly upstream: string;
  /** Defaults to a client that reads `OPENROUTER_API_KEY` from the environment. */
  readonly client?: ChatCompletionsClient;
  readonly maxTokens?: number;
}

/** Fields OpenRouter adds to the Chat Completions usage object. */
interface OpenRouterUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly cost?: number;
}

function toMessageParams(system: string, messages: readonly Message[]): MessageParam[] {
  const params: MessageParam[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      params.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      // Replay the message exactly as it came back, reasoning details included.
      params.push(message.raw as MessageParam);
    } else {
      params.push({
        role: "tool",
        tool_call_id: message.callId,
        // Chat Completions has no error flag on a tool result, so say it in the text.
        content: message.isError ? `Error: ${message.result}` : message.result,
      });
    }
  }
  return params;
}

function parseArguments(name: string, json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new ModelOutputError(`tool call ${name} had arguments that were not valid JSON`);
  }
}

export function openRouterProvider(options: OpenRouterProviderOptions): ModelProvider {
  const client =
    options.client ??
    new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey: process.env["OPENROUTER_API_KEY"] });
  const maxTokens = options.maxTokens ?? 16_000;

  return {
    provider: "openrouter",
    model: options.model,
    async turn(request: TurnRequest): Promise<ModelTurn> {
      const params = {
        model: options.model,
        max_tokens: maxTokens,
        messages: toMessageParams(request.system, request.messages),
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as Record<string, unknown>,
          },
        })),
        // OpenRouter routing, not part of the OpenAI types.
        provider: {
          only: [options.upstream],
          allow_fallbacks: false,
          data_collection: "deny",
        },
      };
      const response = await client.chat.completions.create(params as CreateParams);

      const choice = response.choices?.[0];
      const usage = response.usage as OpenRouterUsage | undefined;
      if (choice === undefined || usage === undefined) {
        // OpenRouter can answer 200 with an error body in place of a completion.
        const error = (response as { error?: { message?: string } }).error;
        throw new Error(`OpenRouter returned no completion: ${error?.message ?? "no detail"}`);
      }
      if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") {
        throw new ModelOutputError(`model stopped with ${choice.finish_reason}`);
      }
      if (choice.message.refusal) {
        throw new ModelOutputError("model stopped with refusal");
      }

      const toolCalls: ToolCall[] = [];
      for (const call of choice.message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          args: parseArguments(call.function.name, call.function.arguments),
        });
      }

      return {
        text: choice.message.content ?? "",
        toolCalls,
        raw: choice.message,
        usage: {
          // Counts come from the model's own tokenizer. Reasoning is inside
          // completion_tokens, as it is billed.
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          ...(usage.cost === undefined ? {} : { reportedCostUsd: usage.cost }),
        },
      };
    },
  };
}
