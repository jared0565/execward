import { runTask, type RunOptions } from "./harness";
import type { EvalTask, ModelProvider, RunRecord, ToolBackend } from "./types";

export interface RoutedRun {
  /** The run that counts: the first one where the route itself did not fail. */
  readonly record: RunRecord;
  /** Every attempt in order, failed routes included, so none goes unreported. */
  readonly attempts: readonly RunRecord[];
}

/**
 * Runs one task on one model, trying each route to it in order. The next route is
 * tried only when the route failed (`provider_error`), never when the model gave
 * a wrong answer, stopped or refused: those are results. A run never changes route
 * part-way, because each route keeps the conversation in its own form.
 */
export async function runWithFallback(
  task: EvalTask,
  routes: readonly ModelProvider[],
  backend: ToolBackend,
  options: RunOptions,
): Promise<RoutedRun> {
  if (routes.length === 0) throw new Error("runWithFallback needs at least one route");
  const attempts: RunRecord[] = [];
  for (const route of routes) {
    const record = await runTask(task, route, backend, options);
    attempts.push(record);
    if (record.failureCause !== "provider_error") return { record, attempts };
  }
  return { record: attempts[attempts.length - 1] as RunRecord, attempts };
}
