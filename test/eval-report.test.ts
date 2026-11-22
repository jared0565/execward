import { expect, test } from "vitest";
import {
  finalRuns,
  renderReport,
  smallestDetectableDrop,
  summarise,
  wilsonInterval,
  type ReportRow,
} from "../src/eval/report";

function row(overrides: Partial<ReportRow>): ReportRow {
  return {
    target: "Model A",
    run: 1,
    costUsd: 0.01,
    taskId: "t1",
    taskType: "bounded_tool_heavy",
    arm: "direct",
    provider: "openrouter",
    model: "a",
    effort: "default",
    success: true,
    failureCause: null,
    failureDetail: null,
    reportedCostUsd: 0.01,
    turns: 2,
    inputTokens: 1000,
    outputTokens: 100,
    toolCalls: 1,
    toolErrors: 0,
    wallClockMs: 10,
    ...overrides,
  };
}

test("a failed route followed by a fallback counts once, as the fallback's result, with both costs", () => {
  const rows = [
    row({ success: false, failureCause: "provider_error", inputTokens: 0, costUsd: 0 }),
    row({ provider: "anthropic", costUsd: 0.02 }),
    row({ run: 2 }),
  ];

  const kept = finalRuns(rows);

  expect(kept).toHaveLength(2);
  expect(kept[0]).toMatchObject({ provider: "anthropic", success: true, costUsd: 0.02 });
  expect(summarise(kept)).toMatchObject({ runs: 2, correct: 2, fallbackRuns: 1 });
});

test("a run where every route failed stays in the count as a failure", () => {
  const rows = [
    row({ success: false, failureCause: "provider_error" }),
    row({ provider: "anthropic", success: false, failureCause: "provider_error" }),
  ];
  expect(summarise(finalRuns(rows))).toMatchObject({ runs: 1, correct: 0, successRate: 0 });
});

test("a summary gives means per run and totals for errors and cost", () => {
  const summary = summarise([
    row({ inputTokens: 1000, turns: 2, toolErrors: 1, costUsd: 0.01 }),
    row({ run: 2, inputTokens: 3000, turns: 4, toolErrors: 2, costUsd: 0.03, success: false, failureCause: "wrong_answer" }),
  ]);
  expect(summary).toMatchObject({ runs: 2, correct: 1, successRate: 0.5, meanInputTokens: 2000, meanTurns: 3, toolErrors: 3 });
  expect(summary.costUsd).toBeCloseTo(0.04);
});

test("the interval is wide for few runs and never claims certainty from a perfect score", () => {
  const few = wilsonInterval(5, 5);
  const many = wilsonInterval(150, 150);
  expect(few.high).toBe(1);
  expect(few.low).toBeLessThan(0.6);
  expect(many.low).toBeGreaterThan(0.97);
  expect(many.low).toBeLessThan(1);
  expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
});

test("more runs can show a smaller drop, and a lower starting rate needs a bigger one", () => {
  const at150 = smallestDetectableDrop(0.98, 150);
  expect(at150).toBeGreaterThan(0.03);
  expect(at150).toBeLessThan(0.1);
  expect(smallestDetectableDrop(0.98, 600)).toBeLessThan(at150);
  expect(smallestDetectableDrop(0.8, 150)).toBeGreaterThan(at150);
});

test("the report has a table per model, the arm comparison and the failures", () => {
  const rows = [
    row({}),
    row({ taskId: "t2", taskType: "exploratory" }),
    row({ arm: "tool_search", inputTokens: 800, costUsd: 0.008 }),
    row({ arm: "tool_search", taskId: "t2", taskType: "exploratory", success: false, failureCause: "wrong_answer", inputTokens: 800, costUsd: 0.008 }),
  ];

  const report = renderReport(rows);

  expect(report).toContain("### Model A");
  expect(report).toContain("| **direct, all tasks** | 2 of 2 | 100.0%");
  expect(report).toContain("| tool search, exploratory | 0 of 1 | 0.0%");
  expect(report).toContain("tool search against direct: input tokens -20.0%, cost per run -20.0%, success -50.0%");
  expect(report).toContain("Failed runs: t2 (tool search, wrong_answer) x1.");
  expect(report).toContain("Total: 4 runs, 3 correct, $0.04.");
});
