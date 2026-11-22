/**
 * Runs the whole task suite on every model with real, paid model calls, and
 * refuses to start another run once spending reaches the cap.
 *
 *   npx tsx scripts/eval-suite.ts --cap 1 [--runs 1] [--out file.jsonl] [--only task-id]
 *
 * --cap   US dollars. Required, so that no run starts without a stated limit.
 * --runs  Times each task runs on each model. Default 1.
 * --out   Where to write one JSON line per attempt. Default eval-results/<time>.jsonl.
 * --golden  Run the golden tasks only (task 0.2.4).
 * --dry-run  Print the plan (how many runs of what) and stop. Makes no model call.
 * --only  Run just this task id. May be repeated.
 * --show-answers  Print each final answer to the console (never to the file).
 *
 * Exits 1 if a key is missing (before any call) or the cap stopped the run early.
 * A wrong answer is a result, not an error, and does not change the exit code.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { githubFixtureBackend } from "../src/eval/fixtures/github-backend";
import { buildWorld } from "../src/eval/fixtures/world";
import { assertKeysPresent } from "../src/eval/preflight";
import { runWithFallback } from "../src/eval/routes";
import { buildGithubTasks } from "../src/eval/tasks/github-tasks";
import { buildGoldenTasks } from "../src/eval/tasks/golden";
import {
  BASELINE_TARGET_NAMES,
  baselineTargets,
  costUsd,
  REQUIRED_KEYS,
  type Target,
} from "../src/eval/targets";
import type { EvalTask, RunRecord } from "../src/eval/types";

const CONCURRENCY = 4;

function option(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((argument, index) => {
    const value = process.argv[index + 1];
    if (argument === `--${name}` && value !== undefined) values.push(value);
  });
  return values;
}

interface Job {
  readonly target: Target;
  readonly task: EvalTask;
  readonly run: number;
}

async function main(): Promise<number> {
  const capUsd = Number(option("cap")[0]);
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error("Cannot start: give a spend cap in US dollars, for example --cap 1");
  }
  const runs = Number(option("runs")[0] ?? 1);
  const only = option("only");
  const out = option("out")[0] ?? `eval-results/${new Date().toISOString().replaceAll(":", "-")}.jsonl`;

  const world = buildWorld();
  const backend = githubFixtureBackend(world);
  const showAnswers = process.argv.includes("--show-answers");
  const tasks = (process.argv.includes("--golden") ? buildGoldenTasks(world) : buildGithubTasks(world))
    .filter((task) => only.length === 0 || only.includes(task.id))
    .map((task): EvalTask =>
      showAnswers
        ? {
            ...task,
            check(answer) {
              const passed = task.check(answer);
              console.log(`answer to ${task.id} (${passed ? "pass" : "fail"}, expected ${task.expected ?? "?"}): ${answer}`);
              return passed;
            },
          }
        : task,
    );
  if (tasks.length === 0) throw new Error("Cannot start: no task matches --only");
  // Say what is about to be paid for, so a wrong selection is seen at once.
  const models = BASELINE_TARGET_NAMES.length;
  console.log(
    `plan: ${tasks.length * models * runs} runs = ${tasks.length} tasks x ${models} models x ${runs} runs, cap $${capUsd}`,
  );
  if (process.argv.includes("--dry-run")) return 0;
  assertKeysPresent(process.env, REQUIRED_KEYS);
  const targets = baselineTargets();
  const jobs: Job[] = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const task of tasks) for (const target of targets) jobs.push({ target, task, run });
  }
  mkdirSync(dirname(out), { recursive: true });

  let spentUsd = 0;
  let skipped = 0;
  const results: { job: Job; record: RunRecord }[] = [];
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
      if (spentUsd >= capUsd) {
        skipped += 1;
        continue;
      }
      const routed = await runWithFallback(job.task, job.target.routes, backend, { arm: "direct" });
      for (const attempt of routed.attempts) {
        const cost = costUsd(job.target, attempt);
        spentUsd += cost;
        appendFileSync(out, `${JSON.stringify({ target: job.target.name, run: job.run, costUsd: cost, ...attempt })}\n`);
      }
      results.push({ job, record: routed.record });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const target of targets) {
    const mine = results.filter((result) => result.job.target === target).map((result) => result.record);
    const passed = mine.filter((record) => record.success).length;
    const sum = (pick: (record: RunRecord) => number): number => mine.reduce((total, record) => total + pick(record), 0);
    console.log(
      `${target.name}: ${passed}/${mine.length} correct, ${sum((r) => r.inputTokens)} input and ${sum((r) => r.outputTokens)} output tokens, ` +
        `$${sum((r) => costUsd(target, r)).toFixed(4)}, ${mine.filter((r) => r.provider !== "openrouter").length} runs on the fallback route`,
    );
    for (const { job, record } of results) {
      if (job.target === target && !record.success) {
        console.log(`  failed: ${job.task.id} (${record.failureCause}${record.failureDetail === null ? "" : `: ${record.failureDetail}`}) after ${record.turns} turns`);
      }
    }
  }
  console.log(`spent $${spentUsd.toFixed(4)} of the $${capUsd} cap; results in ${out}`);
  if (skipped > 0) {
    console.log(`STOPPED BY THE CAP: ${skipped} runs were not started.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
