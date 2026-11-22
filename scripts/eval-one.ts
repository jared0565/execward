/**
 * Runs ONE small task on the fixture GitHub tools on each model, with real, paid
 * model calls, to prove the harness and every route work end to end (task 0.2.2).
 *
 *   npx tsx scripts/eval-one.ts              OpenRouter first, direct on failure
 *   npx tsx scripts/eval-one.ts --each-route also run every direct route once
 *
 * Prints one JSON line per attempt. Exits 1 if a key is missing (before any call)
 * or if any model ends without a successful run.
 */
import { githubFixtureBackend } from "../src/eval/fixtures/github-backend";
import { buildWorld } from "../src/eval/fixtures/world";
import { assertKeysPresent } from "../src/eval/preflight";
import { runWithFallback } from "../src/eval/routes";
import { buildGithubTasks } from "../src/eval/tasks/github-tasks";
import { baselineTargets, costUsd, estimatedCostUsd, REQUIRED_KEYS } from "../src/eval/targets";

async function main(): Promise<number> {
  assertKeysPresent(process.env, REQUIRED_KEYS);
  const world = buildWorld();
  const backend = githubFixtureBackend(world);
  const task = buildGithubTasks(world)[0];
  if (task === undefined) throw new Error("the task suite is empty");
  const eachRoute = process.argv.includes("--each-route");
  let failed = false;
  let spendUsd = 0;

  for (const target of baselineTargets()) {
    const routeSets = eachRoute ? target.routes.map((route) => [route]) : [target.routes];
    for (const routes of routeSets) {
      const run = await runWithFallback(task, routes, backend, { arm: "direct" });
      for (const attempt of run.attempts) {
        spendUsd += costUsd(target, attempt);
        console.log(
          JSON.stringify({
            target: target.name,
            ...attempt,
            estimatedCostUsd: estimatedCostUsd(target, attempt),
          }),
        );
      }
      if (!run.record.success) failed = true;
    }
  }
  console.log(`total spend, reported where available and estimated otherwise: $${spendUsd.toFixed(5)}`);
  return failed ? 1 : 0;
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
