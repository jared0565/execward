/**
 * Runs the whole task suite on every model with real, paid model calls, and
 * refuses to start another run once spending reaches the cap.
 *
 *   npx tsx scripts/eval-suite.ts --cap 1 [--runs 1] [--out file.jsonl] [--only task-id]
 *
 * --cap   US dollars. Required, so that no run starts without a stated limit.
 * --runs  Times each task runs on each model. Default 1.
 * --out   Where to write one JSON line per attempt. Default eval-results/<time>.jsonl.
 * --arm   direct, tool_search or code. May be repeated. Default direct.
 *         code runs each script on the deployed test Worker; its address and test secret come
 *         from EXECWARD_TEST_URL and EXECWARD_TEST_SECRET, or the files in the .execward folder
 *         in the home folder.
 * --direct-route  Skip OpenRouter and call each provider's own API.
 * --resume  With --out naming an existing file: keep its results and run only what is missing.
 * --golden  Run the golden tasks only (task 0.2.4).
 * --dry-run  Print the plan (how many runs of what) and stop. Makes no model call.
 * --only  Run just this task id. May be repeated.
 * --show-answers  Also print each final answer to the console. Answers are always saved in the file.
 * --show-tool-errors  Print each tool call that returned an error, with its arguments.
 * --show-scripts  With --arm code: print each script and the start of its result.
 *
 * Exits 1 if a key is missing (before any call) or the cap stopped the run early.
 * A wrong answer is a result, not an error, and does not change the exit code.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { codeBackend, remoteFixtureRunner, type CodeBackend, type CodeRunner } from "../src/eval/arms/code";
import { toolSearchBackend } from "../src/eval/arms/tool-search";
import { githubFixtureBackend } from "../src/eval/fixtures/github-backend";
import { buildWorld } from "../src/eval/fixtures/world";
import { assertKeysPresent } from "../src/eval/preflight";
import { finalRuns, type ReportRow } from "../src/eval/report";
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
import type { Arm, EvalTask, RunRecord, ToolBackend } from "../src/eval/types";

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
  readonly arm: Arm;
}

async function main(): Promise<number> {
  const capUsd = Number(option("cap")[0]);
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error("Cannot start: give a spend cap in US dollars, for example --cap 1");
  }
  const runs = Number(option("runs")[0] ?? 1);
  const only = option("only");
  const arms = (option("arm").length === 0 ? ["direct"] : option("arm")) as Arm[];
  for (const arm of arms) {
    if (arm !== "direct" && arm !== "tool_search" && arm !== "code") throw new Error(`Cannot start: unknown arm ${String(arm)}`);
  }
  let codeRunner: CodeRunner | undefined;
  if (arms.includes("code")) {
    const setting = (name: string, file: string): string => {
      const fromEnv = process.env[name];
      if (fromEnv) return fromEnv.trim();
      const path = join(homedir(), ".execward", file);
      if (!existsSync(path)) throw new Error(`Cannot start: set ${name}, or create ${path}`);
      return readFileSync(path, "utf8").trim();
    };
    codeRunner = remoteFixtureRunner(setting("EXECWARD_TEST_URL", "test-worker-url"), setting("EXECWARD_TEST_SECRET", "test-worker-secret"));
  }
  const directRoute = process.argv.includes("--direct-route");
  const out = option("out")[0] ?? `eval-results/${new Date().toISOString().replaceAll(":", "-")}.jsonl`;

  const world = buildWorld();
  const backend = githubFixtureBackend(world);
  const showAnswers = process.argv.includes("--show-answers");
  const showToolErrors = process.argv.includes("--show-tool-errors");
  const showScripts = process.argv.includes("--show-scripts");
  const tasks = (process.argv.includes("--golden") ? buildGoldenTasks(world) : buildGithubTasks(world))
    .filter((task) => only.length === 0 || only.includes(task.id));
  if (tasks.length === 0) throw new Error("Cannot start: no task matches --only");
  // Say what is about to be paid for, so a wrong selection is seen at once.
  const models = BASELINE_TARGET_NAMES.length;
  console.log(
    `plan: ${tasks.length * models * runs * arms.length} runs = ${tasks.length} tasks x ${models} models x ${arms.length} arms (${arms.join(", ")}) x ${runs} runs, ` +
      `${directRoute ? "direct provider APIs" : "OpenRouter first"}, cap $${capUsd}`,
  );
  if (process.argv.includes("--dry-run")) return 0;
  assertKeysPresent(process.env, REQUIRED_KEYS);
  const targets = baselineTargets();
  const jobs: Job[] = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const task of tasks) for (const target of targets) for (const arm of arms) jobs.push({ target, task, run, arm });
  }
  mkdirSync(dirname(out), { recursive: true });

  let spentUsd = 0;
  if (process.argv.includes("--resume") && existsSync(out)) {
    // Carry on an interrupted run: keep what the file already holds, count its cost
    // towards the cap, and start only the runs that have no result yet.
    const earlier: ReportRow[] = [];
    for (const line of readFileSync(out, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        earlier.push(JSON.parse(line) as ReportRow);
      } catch {
        console.log("resume: skipped one unreadable line (an interrupted write)");
      }
    }
    spentUsd = earlier.reduce((total, row) => total + row.costUsd, 0);
    const key = (target: string, arm: Arm, taskId: string, run: number): string => [target, arm, taskId, run].join("|");
    const done = new Set(
      finalRuns(earlier)
        .filter((row) => row.failureCause !== "provider_error")
        .map((row) => key(row.target, row.arm, row.taskId, row.run)),
    );
    const before = jobs.length;
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      const job = jobs[index] as Job;
      if (done.has(key(job.target.name, job.arm, job.task.id, job.run))) jobs.splice(index, 1);
    }
    console.log(
      `resume: ${before - jobs.length} runs already in ${out} ($${spentUsd.toFixed(4)} spent), ${jobs.length} to go. ` +
        "The summary below covers this session only; use baseline-report.ts for the whole file.",
    );
  }
  let skipped = 0;
  const results: { job: Job; record: RunRecord }[] = [];
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
      if (spentUsd >= capUsd) {
        skipped += 1;
        continue;
      }
      const routes = directRoute ? job.target.routes.slice(1) : job.target.routes;
      // The tool-search wrapper remembers what a run has found, so each run gets its own.
      // The code wrapper holds the retry count of the task, so each run gets its own too.
      const runner = codeRunner;
      const shownRunner: CodeRunner | undefined =
        runner && showScripts
          ? async (input) => {
              const output = await runner(input);
              console.log(`script in ${job.task.id} on ${job.target.name}:
${String(input.script)}
-> ${JSON.stringify(output).slice(0, 1500)}
`);
              return output;
            }
          : runner;
      const code: CodeBackend | undefined = job.arm === "code" && shownRunner ? codeBackend(shownRunner) : undefined;
      const armBackend = code ?? (job.arm === "tool_search" ? toolSearchBackend(backend) : backend);
      const runBackend: ToolBackend = !showToolErrors
        ? armBackend
        : {
            definitions: armBackend.definitions,
            call: (name, args) =>
              armBackend.call(name, args).catch((error: unknown) => {
                console.log(`tool error in ${job.task.id} [${job.arm}] on ${job.target.name}: ${name}(${JSON.stringify(args)}) -> ${String(error)}`);
                throw error;
              }),
          };
      // Keep the final answer beside the result, so a changed check can re-score
      // old runs without paying for them again. The data is the invented fixture.
      let answer: string | null = null;
      const task: EvalTask = {
        ...job.task,
        check(given) {
          answer = given;
          const passed = job.task.check(given);
          if (showAnswers) {
            console.log(`answer to ${job.task.id} [${job.arm}] on ${job.target.name} (${passed ? "pass" : "fail"}, expected ${job.task.expected ?? "?"}): ${given}`);
          }
          return passed;
        },
      };
      const routed = await runWithFallback(task, routes, runBackend, { arm: job.arm });
      for (const attempt of routed.attempts) {
        const cost = costUsd(job.target, attempt);
        spentUsd += cost;
        appendFileSync(out, `${JSON.stringify({ target: job.target.name, run: job.run, costUsd: cost, ...attempt, answer: attempt === routed.record ? answer : null, ...(code && attempt === routed.record ? { codeRuns: code.outcomes } : {}) })}\n`);
      }
      results.push({ job, record: routed.record });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const target of targets) for (const arm of arms) {
    const mine = results.filter((result) => result.job.target === target && result.job.arm === arm).map((result) => result.record);
    const passed = mine.filter((record) => record.success).length;
    const sum = (pick: (record: RunRecord) => number): number => mine.reduce((total, record) => total + pick(record), 0);
    console.log(
      `${target.name} [${arm}]: ${passed}/${mine.length} correct, ${sum((r) => r.inputTokens)} input and ${sum((r) => r.outputTokens)} output tokens, ` +
        `$${sum((r) => costUsd(target, r)).toFixed(4)}, ${mine.filter((r) => r.provider !== "openrouter").length} runs on the fallback route`,
    );
    for (const { job, record } of results) {
      if (job.target === target && job.arm === arm && !record.success) {
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
