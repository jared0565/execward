import { expect, test } from "vitest";
import { buildWorld } from "../src/eval/fixtures/world";
import { buildGoldenTasks, GOLDEN_TASK_IDS } from "../src/eval/tasks/golden";

const golden = buildGoldenTasks(buildWorld());

test("every golden id names a task in the suite, once", () => {
  expect(golden.map((task) => task.id)).toEqual([...GOLDEN_TASK_IDS]);
  expect(new Set(GOLDEN_TASK_IDS).size).toBe(GOLDEN_TASK_IDS.length);
});

test("each golden task has a known answer that its check accepts and a wrong one it rejects", () => {
  for (const task of golden) {
    expect(task.expected, task.id).toBeTruthy();
    expect(task.check(task.expected ?? ""), task.id).toBe(true);
    expect(task.check("987654"), task.id).toBe(false);
    expect(task.check(""), task.id).toBe(false);
  }
});

test("the golden set is small and covers both task types", () => {
  expect(golden.length).toBeGreaterThanOrEqual(5);
  expect(golden.length).toBeLessThanOrEqual(12);
  expect(new Set(golden.map((task) => task.type))).toEqual(
    new Set(["bounded_tool_heavy", "exploratory"]),
  );
});
