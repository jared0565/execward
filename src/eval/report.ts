/**
 * Turns run records into the numbers of a baseline report (task 0.2.5): success,
 * tokens and cost per model, arm and task type, and the smallest success drop the
 * suite could detect.
 */
import type { Arm, RunRecord, TaskType } from "./types";

/** A run record as the suite runner writes it: with the model's name, run number and cost. */
export interface ReportRow extends RunRecord {
  readonly target: string;
  readonly run: number;
  readonly costUsd: number;
}

export interface GroupSummary {
  readonly runs: number;
  readonly correct: number;
  readonly successRate: number;
  readonly meanInputTokens: number;
  readonly meanOutputTokens: number;
  readonly meanTurns: number;
  readonly meanToolCalls: number;
  readonly toolErrors: number;
  readonly costUsd: number;
  /** Runs that ended on a route other than OpenRouter. */
  readonly fallbackRuns: number;
}

/**
 * Keeps the run that counts for each task run: a failed route (`provider_error`)
 * that was followed by a fallback attempt is dropped, a run where every route
 * failed is kept as a failure. Costs of dropped attempts are added to the kept one.
 */
export function finalRuns(rows: readonly ReportRow[]): ReportRow[] {
  const byRun = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const key = [row.target, row.arm, row.taskId, row.run].join("|");
    byRun.set(key, [...(byRun.get(key) ?? []), row]);
  }
  return [...byRun.values()].map((attempts) => {
    const last = attempts[attempts.length - 1] as ReportRow;
    return { ...last, costUsd: attempts.reduce((total, attempt) => total + attempt.costUsd, 0) };
  });
}

export function summarise(rows: readonly ReportRow[]): GroupSummary {
  const runs = rows.length;
  const sum = (pick: (row: ReportRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  const mean = (pick: (row: ReportRow) => number): number => (runs === 0 ? 0 : sum(pick) / runs);
  const correct = rows.filter((row) => row.success).length;
  return {
    runs,
    correct,
    successRate: runs === 0 ? 0 : correct / runs,
    meanInputTokens: mean((row) => row.inputTokens),
    meanOutputTokens: mean((row) => row.outputTokens),
    meanTurns: mean((row) => row.turns),
    meanToolCalls: mean((row) => row.toolCalls),
    toolErrors: sum((row) => row.toolErrors),
    costUsd: sum((row) => row.costUsd),
    fallbackRuns: rows.filter((row) => row.provider !== "openrouter").length,
  };
}

/** Wilson score interval for a proportion, at 95% confidence. */
export function wilsonInterval(correct: number, runs: number): { low: number; high: number } {
  if (runs === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = correct / runs;
  const centre = p + (z * z) / (2 * runs);
  const margin = z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs));
  const scale = 1 + (z * z) / runs;
  return { low: Math.max(0, (centre - margin) / scale), high: Math.min(1, (centre + margin) / scale) };
}

/**
 * The smallest drop in success rate that a second arm of the same size would
 * show reliably: a one-sided test at 5% with 80% power, normal approximation.
 * It treats runs as independent, which runs of the same task are not quite, so
 * the true figure is somewhat larger.
 */
export function smallestDetectableDrop(successRate: number, runsPerArm: number): number {
  const needed = 1.645 + 0.842;
  for (let drop = 0.001; drop <= successRate; drop += 0.001) {
    const lower = successRate - drop;
    const spread = Math.sqrt(
      (successRate * (1 - successRate)) / runsPerArm + (lower * (1 - lower)) / runsPerArm,
    );
    if (spread > 0 && drop / spread >= needed) return Math.round(drop * 1000) / 1000;
  }
  return successRate;
}

const ARM_NAMES: Readonly<Record<Arm, string>> = {
  direct: "direct",
  tool_search: "tool search",
  code: "code tool",
};
const TYPE_NAMES: Readonly<Record<TaskType, string>> = {
  bounded_tool_heavy: "bounded tool-heavy",
  exploratory: "exploratory",
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const whole = (value: number): string => Math.round(value).toLocaleString("en-US");

function row(label: string, summary: GroupSummary): string {
  const interval = wilsonInterval(summary.correct, summary.runs);
  return (
    `| ${label} | ${summary.correct} of ${summary.runs} | ${percent(summary.successRate)} ` +
    `(${percent(interval.low)} to ${percent(interval.high)}) | ${whole(summary.meanInputTokens)} | ` +
    `${whole(summary.meanOutputTokens)} | ${summary.meanTurns.toFixed(2)} | ${summary.meanToolCalls.toFixed(2)} | ` +
    `${summary.toolErrors} | $${summary.costUsd.toFixed(3)} |`
  );
}

const HEADER =
  "| | Correct | Success (95% interval) | Mean input tokens | Mean output tokens | Mean turns | Mean tool calls | Tool errors | Cost |\n" +
  "|---|---|---|---|---|---|---|---|---|";

/** The tables of the baseline report, as Markdown. */
export function renderReport(allRows: readonly ReportRow[]): string {
  const rows = finalRuns(allRows);
  const targets = [...new Set(rows.map((entry) => entry.target))];
  const arms = [...new Set(rows.map((entry) => entry.arm))];
  const types = [...new Set(rows.map((entry) => entry.taskType))];
  const lines: string[] = [];

  for (const target of targets) {
    const ofTarget = rows.filter((entry) => entry.target === target);
    lines.push(`### ${target}`, "", HEADER);
    for (const arm of arms) {
      const ofArm = ofTarget.filter((entry) => entry.arm === arm);
      lines.push(row(`**${ARM_NAMES[arm]}, all tasks**`, summarise(ofArm)));
      for (const type of types) {
        lines.push(row(`${ARM_NAMES[arm]}, ${TYPE_NAMES[type]}`, summarise(ofArm.filter((entry) => entry.taskType === type))));
      }
    }
    const direct = summarise(ofTarget.filter((entry) => entry.arm === "direct"));
    lines.push("");
    for (const arm of arms.filter((candidate) => candidate !== "direct")) {
      const other = summarise(ofTarget.filter((entry) => entry.arm === arm));
      if (direct.runs === 0 || other.runs === 0) continue;
      const tokenChange = other.meanInputTokens / direct.meanInputTokens - 1;
      const costChange = other.costUsd / other.runs / (direct.costUsd / direct.runs) - 1;
      lines.push(
        `- ${ARM_NAMES[arm]} against direct: input tokens ${percent(tokenChange)}, cost per run ${percent(costChange)}, ` +
          `success ${percent(other.successRate - direct.successRate)} (percentage points).`,
      );
    }
    if (direct.runs > 0) {
      lines.push(
        `- Smallest success drop a ${direct.runs}-run arm can show against this direct arm: ` +
          `${percent(smallestDetectableDrop(direct.successRate, direct.runs))} (percentage points).`,
      );
    }
    const failures = new Map<string, number>();
    for (const entry of ofTarget.filter((candidate) => !candidate.success)) {
      const key = `${entry.taskId} (${ARM_NAMES[entry.arm]}, ${entry.failureCause ?? "unknown"})`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
    lines.push(
      failures.size === 0
        ? "- No failed runs."
        : `- Failed runs: ${[...failures].map(([key, count]) => `${key} x${count}`).join("; ")}.`,
      `- Runs that ended on the fallback route: ${summarise(ofTarget).fallbackRuns} of ${ofTarget.length}.`,
      "",
    );
  }
  const total = summarise(rows);
  lines.push(`Total: ${total.runs} runs, ${total.correct} correct, $${total.costUsd.toFixed(2)}.`);
  return lines.join("\n");
}
