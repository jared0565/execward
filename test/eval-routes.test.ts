import { expect, test } from "vitest";
import { assertKeysPresent, missingKeys } from "../src/eval/preflight";
import { runWithFallback } from "../src/eval/routes";
import {
  ModelOutputError,
  type EvalTask,
  type ModelProvider,
  type ModelTurn,
  type ToolBackend,
} from "../src/eval/types";

const task: EvalTask = {
  id: "t1",
  type: "bounded_tool_heavy",
  prompt: "q",
  check: (answer) => answer === "42",
};
const backend: ToolBackend = { definitions: [], call: () => Promise.resolve(null) };
const answer: ModelTurn = { text: "42", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };

function route(name: string, turn: () => Promise<ModelTurn>): ModelProvider & { calls: number } {
  const self = {
    provider: name,
    model: "m",
    calls: 0,
    turn() {
      self.calls += 1;
      return turn();
    },
  };
  return self;
}

test("the first route is used alone when it works", async () => {
  const first = route("openrouter", () => Promise.resolve(answer));
  const second = route("direct", () => Promise.resolve(answer));

  const run = await runWithFallback(task, [first, second], backend, { arm: "direct" });

  expect(run.record).toMatchObject({ provider: "openrouter", success: true });
  expect(run.attempts).toHaveLength(1);
  expect(second.calls).toBe(0);
});

test("a failed route falls back, and the failed attempt is still reported", async () => {
  const first = route("openrouter", () => Promise.reject(new Error("502 from upstream")));
  const second = route("direct", () => Promise.resolve(answer));

  const run = await runWithFallback(task, [first, second], backend, { arm: "direct" });

  expect(run.record).toMatchObject({ provider: "direct", success: true });
  expect(run.attempts.map((attempt) => attempt.failureCause)).toEqual(["provider_error", null]);
  expect(run.attempts[0]?.failureDetail).toBe("502 from upstream");
});

test("a model that stops or answers wrongly is a result, not a reason to fall back", async () => {
  const second = route("direct", () => Promise.resolve(answer));

  const stopped = route("openrouter", () => Promise.reject(new ModelOutputError("refusal")));
  const stoppedRun = await runWithFallback(task, [stopped, second], backend, { arm: "direct" });
  expect(stoppedRun.record).toMatchObject({ provider: "openrouter", failureCause: "model_stopped" });

  const wrong = route("openrouter", () => Promise.resolve({ ...answer, text: "41" }));
  const wrongRun = await runWithFallback(task, [wrong, second], backend, { arm: "direct" });
  expect(wrongRun.record).toMatchObject({ provider: "openrouter", failureCause: "wrong_answer" });

  expect(second.calls).toBe(0);
});

test("when every route fails the last failure is the record", async () => {
  const first = route("openrouter", () => Promise.reject(new Error("a")));
  const second = route("direct", () => Promise.reject(new Error("b")));

  const run = await runWithFallback(task, [first, second], backend, { arm: "direct" });

  expect(run.record).toMatchObject({ provider: "direct", failureCause: "provider_error" });
  expect(run.attempts).toHaveLength(2);
});

test("cost is reported only when every turn reported one, and effort is recorded", async () => {
  const priced = route("openrouter", () =>
    Promise.resolve({ ...answer, usage: { inputTokens: 1, outputTokens: 1, reportedCostUsd: 0.5 } }),
  );
  const pricedRun = await runWithFallback(task, [priced], backend, { arm: "direct" });
  expect(pricedRun.record).toMatchObject({ reportedCostUsd: 0.5, effort: "default" });

  const unpriced = route("direct", () => Promise.resolve(answer));
  const unpricedRun = await runWithFallback(task, [unpriced], backend, { arm: "direct" });
  expect(unpricedRun.record.reportedCostUsd).toBeNull();
});

test("a missing key is named before any call, and its value is never shown", () => {
  const env = { A_KEY: "secret-value", B_KEY: "", C_KEY: undefined };

  expect(missingKeys(env, ["A_KEY", "B_KEY", "C_KEY", "D_KEY"])).toEqual([
    "B_KEY",
    "C_KEY",
    "D_KEY",
  ]);
  expect(() => assertKeysPresent(env, ["A_KEY"])).not.toThrow();
  expect(() => assertKeysPresent(env, ["A_KEY", "B_KEY"])).toThrow(
    "Cannot start: B_KEY is not set. No model call was made.",
  );
  try {
    assertKeysPresent(env, ["A_KEY", "D_KEY"]);
  } catch (error) {
    expect(String(error)).not.toContain("secret-value");
  }
});
