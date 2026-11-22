/**
 * Types for the evaluation harness (task 0.2.2). The harness runs one task on one
 * model and records what the provider itself reports, never an estimate.
 */

/** A tool as offered to a model. `inputSchema` is JSON Schema. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export type Message =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
      /** The provider's own form of this turn, replayed unchanged on later turns. */
      readonly raw?: unknown;
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly result: string;
      readonly isError: boolean;
    };

/** Token counts as reported by the provider for one model turn. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  /**
   * The provider's own form of the turn. Some providers require it back
   * unchanged, for example thinking blocks, so adapters replay it as it came.
   */
  readonly raw?: unknown;
}

export interface TurnRequest {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
}

/** One model behind one provider API. Adapters translate to and from this shape. */
export interface ModelProvider {
  readonly provider: string;
  readonly model: string;
  turn(request: TurnRequest): Promise<ModelTurn>;
}

/** The tools a task may use, and the code that answers them. */
export interface ToolBackend {
  readonly definitions: readonly ToolDefinition[];
  call(name: string, args: unknown): Promise<unknown>;
}

export type TaskType = "bounded_tool_heavy" | "exploratory";

export interface EvalTask {
  readonly id: string;
  readonly type: TaskType;
  readonly prompt: string;
  /** Automatic pass or fail on the final answer. */
  check(answer: string): boolean;
}

/** Which way the model reached the tools. */
export type Arm = "direct" | "tool_search" | "code";

export type FailureCause = "wrong_answer" | "no_answer" | "turn_limit" | "provider_error";

export interface RunRecord {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly arm: Arm;
  readonly provider: string;
  readonly model: string;
  readonly success: boolean;
  readonly failureCause: FailureCause | null;
  /** Detail for a provider error. Never model output. */
  readonly failureDetail: string | null;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly wallClockMs: number;
}
