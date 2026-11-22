/**
 * Runs ONE small task on the fixture GitHub tools on each configured model with real, paid model calls, to
 * prove the harness and every route work end to end (task 0.2.2).
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
import { anthropicProvider } from "../src/eval/providers/anthropic";
import { openAIProvider } from "../src/eval/providers/openai";
import { openRouterProvider } from "../src/eval/providers/openrouter";
import { runWithFallback } from "../src/eval/routes";
import type { EvalTask, ModelProvider } from "../src/eval/types";

/** US dollars per million tokens, from the providers' price pages on 2026-11-22. */
const PRICE_PER_MTOK = { input: 0.1, output: 0.5 };

const world = buildWorld();
const backend = githubFixtureBackend(world);
const repo = world.repos[0];
if (repo === undefined) throw new Error("the fixture world has no repository");
const openIssues = repo.issues.filter((issue) => issue.pull === null && issue.state === "open").length;

const task: EvalTask = {
  id: "smoke-count-open-issues",
  type: "bounded_tool_heavy",
  prompt:
    `How many open issues does the repository ${repo.owner}/${repo.name} have? ` +
    "Count issues only, not pull requests. Reply with the number.",
  check: (answer) => new RegExp(`\\b${openIssues}\\b`).test(answer),
};

interface Target {
  readonly name: string;
  readonly routes: readonly ModelProvider[];
}

function targets(): Target[] {
  return [
    {
      name: "Claude Haiku 5.5",
      routes: [
        openRouterProvider({ model: "anthropic/claude-haiku-5.5", upstream: "anthropic" }),
        anthropicProvider({ model: "claude-haiku-5-5" }),
      ],
    },
    {
      name: "GPT-6 Luna",
      routes: [
        openRouterProvider({ model: "openai/gpt-6-luna", upstream: "openai" }),
        openAIProvider({ model: "gpt-6-luna" }),
      ],
    },
  ];
}

async function main(): Promise<number> {
  assertKeysPresent(process.env, ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  const eachRoute = process.argv.includes("--each-route");
  let failed = false;
  let spendUsd = 0;

  for (const target of targets()) {
    const routeSets = eachRoute ? target.routes.map((route) => [route]) : [target.routes];
    for (const routes of routeSets) {
      const run = await runWithFallback(task, routes, backend, { arm: "direct" });
      for (const attempt of run.attempts) {
        const estimatedCostUsd =
          (attempt.inputTokens * PRICE_PER_MTOK.input +
            attempt.outputTokens * PRICE_PER_MTOK.output) /
          1_000_000;
        spendUsd += attempt.reportedCostUsd ?? estimatedCostUsd;
        console.log(JSON.stringify({ target: target.name, ...attempt, estimatedCostUsd }));
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
