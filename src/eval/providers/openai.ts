/**
 * OpenAI adapter for the eval harness, on the Responses API. Used as the direct
 * route when OpenRouter fails. The harness owns the loop; this file only translates.
 *
 * Requests are stateless (`store: false`): the whole history is sent each turn and
 * the model's output items, reasoning included, are replayed as they came.
 */
import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { ModelOutputError } from "../types";
import type { Message, ModelProvider, ModelTurn, ToolCall, TurnRequest } from "../types";

type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type InputItem = OpenAI.Responses.ResponseInputItem;

/** The part of the SDK client this adapter uses. Narrow so tests can supply a fake. */
export interface OpenAIResponsesClient {
  responses: {
    create(params: CreateParams): Promise<OpenAI.Responses.Response>;
  };
}

export interface OpenAIProviderOptions {
  readonly model: string;
  /** Defaults to a client that reads `OPENAI_API_KEY` from the environment. */
  readonly client?: OpenAIResponsesClient;
  readonly maxOutputTokens?: number;
}

function toInput(messages: readonly Message[]): InputItem[] {
  const input: InputItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      // Replay every output item in its original order, reasoning items included.
      input.push(...(message.raw as InputItem[]));
    } else {
      input.push({
        type: "function_call_output",
        call_id: message.callId,
        // The Responses API has no error flag on a tool result, so say it in the text.
        output: message.isError ? `Error: ${message.result}` : message.result,
      });
    }
  }
  return input;
}

function parseArguments(name: string, json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new ModelOutputError(`tool call ${name} had arguments that were not valid JSON`);
  }
}

export function openAIProvider(options: OpenAIProviderOptions): ModelProvider {
  const client = options.client ?? new OpenAI();
  const maxOutputTokens = options.maxOutputTokens ?? 16_000;

  return {
    provider: "openai",
    model: options.model,
    async turn(request: TurnRequest): Promise<ModelTurn> {
      const response = await client.responses.create({
        model: options.model,
        instructions: request.system,
        input: toInput(request.messages),
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as Record<string, unknown>,
          // The inventory schemas have optional fields, which strict mode forbids.
          strict: false,
        })),
        max_output_tokens: maxOutputTokens,
        store: false,
      });

      if (response.status === "incomplete") {
        throw new ModelOutputError(
          `model stopped with ${response.incomplete_details?.reason ?? "incomplete"}`,
        );
      }
      if (response.status !== "completed" || response.usage === undefined) {
        throw new Error(
          `OpenAI response ${response.status ?? "unknown"}: ${response.error?.message ?? "no detail"}`,
        );
      }

      const toolCalls: ToolCall[] = [];
      let text = "";
      for (const item of response.output) {
        if (item.type === "function_call") {
          toolCalls.push({
            id: item.call_id,
            name: item.name,
            args: parseArguments(item.name, item.arguments),
          });
        } else if (item.type === "message") {
          for (const part of item.content) {
            if (part.type === "refusal") throw new ModelOutputError("model stopped with refusal");
            if (part.type === "output_text") text += part.text;
          }
        }
      }

      return {
        text,
        toolCalls,
        raw: toResponseInputItems(response.output),
        usage: {
          // Reasoning tokens are inside output_tokens, as they are billed.
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
