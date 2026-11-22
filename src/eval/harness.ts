import { ModelOutputError } from "./types";
import type {
  Arm,
  EvalTask,
  FailureCause,
  Message,
  ModelProvider,
  ModelTurn,
  RunRecord,
  ToolBackend,
} from "./types";

export const EVAL_SYSTEM_PROMPT =
  "Use the tools to answer the question. When you have the answer, reply with the answer only.";

export interface RunOptions {
  readonly arm: Arm;
  /** Model turns allowed before the run is ended as a failure. */
  readonly maxTurns?: number;
  /** Clock in milliseconds. Replaceable so tests are deterministic. */
  readonly now?: () => number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one task on one model: offer the tools, carry out each tool call the
 * model asks for, and stop at the first turn with no tool call. Token counts are
 * summed from what the provider reports each turn.
 */
export async function runTask(
  task: EvalTask,
  provider: ModelProvider,
  backend: ToolBackend,
  options: RunOptions,
): Promise<RunRecord> {
  const maxTurns = options.maxTurns ?? 20;
  const now = options.now ?? Date.now;
  const started = now();
  const messages: Message[] = [{ role: "user", text: task.prompt }];
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let reportedCostUsd = 0;
  let everyTurnReportedCost = true;

  const finish = (
    failureCause: FailureCause | null,
    failureDetail: string | null = null,
  ): RunRecord => ({
    taskId: task.id,
    taskType: task.type,
    arm: options.arm,
    provider: provider.provider,
    model: provider.model,
    effort: provider.effort ?? "default",
    success: failureCause === null,
    failureCause,
    failureDetail,
    reportedCostUsd: turns > 0 && everyTurnReportedCost ? reportedCostUsd : null,
    turns,
    inputTokens,
    outputTokens,
    toolCalls,
    toolErrors,
    wallClockMs: now() - started,
  });

  while (turns < maxTurns) {
    let turn: ModelTurn;
    try {
      turn = await provider.turn({
        system: EVAL_SYSTEM_PROMPT,
        messages,
        tools: backend.definitions,
      });
    } catch (error) {
      return finish(
        error instanceof ModelOutputError ? "model_stopped" : "provider_error",
        describeError(error),
      );
    }
    turns += 1;
    inputTokens += turn.usage.inputTokens;
    outputTokens += turn.usage.outputTokens;
    if (turn.usage.reportedCostUsd === undefined) everyTurnReportedCost = false;
    else reportedCostUsd += turn.usage.reportedCostUsd;

    if (turn.toolCalls.length === 0) {
      if (turn.text.trim() === "") return finish("no_answer");
      return finish(task.check(turn.text) ? null : "wrong_answer");
    }

    messages.push({
      role: "assistant",
      text: turn.text,
      toolCalls: turn.toolCalls,
      ...(turn.raw === undefined ? {} : { raw: turn.raw }),
    });
    for (const call of turn.toolCalls) {
      toolCalls += 1;
      try {
        const result = await backend.call(call.name, call.args);
        messages.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          result: JSON.stringify(result) ?? "null",
          isError: false,
        });
      } catch (error) {
        toolErrors += 1;
        messages.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          result: describeError(error),
          isError: true,
        });
      }
    }
  }
  return finish("turn_limit");
}
