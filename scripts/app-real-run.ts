/**
 * Runs the test app with real, paid models (task 1.9.2): one Claude model and
 * one GPT model, each given a few questions about a public repository.
 *
 *   npx tsx scripts/app-real-run.ts            cap $1.00
 *   npx tsx scripts/app-real-run.ts --cap 0.25 a lower cap
 *   npx tsx scripts/app-real-run.ts --direct   each provider's own API, not OpenRouter
 *
 * The whole path is real. The model is reached through OpenRouter. The `code`
 * tool runs on the deployed test Worker: static check, sandbox, broker, pinned
 * definitions, policy, and the GitHub connector reading GitHub itself.
 *
 * Money: spend is counted after every model turn, from what the route says it
 * charged, or from tokens at list price when it does not say. No turn starts
 * once the cap is reached. Exits 1 if a key or setting is missing, before any
 * paid call.
 *
 * Prints one JSON line per task. Nothing printed holds a key.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAppTask } from "../src/app/agent";
import { codeToolOutputSchema, type CodeToolOutput } from "../src/contracts/code-tool";
import { anthropicProvider } from "../src/eval/providers/anthropic";
import { openAIProvider } from "../src/eval/providers/openai";
import { openRouterProvider } from "../src/eval/providers/openrouter";
import type { ModelProvider } from "../src/eval/types";
import type { CodeToolService } from "../src/service";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

// --direct uses each provider's own API. The default goes through OpenRouter, as the baseline did.
const DIRECT = process.argv.includes("--direct");
for (const key of DIRECT ? ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] : ["OPENROUTER_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} is not set. Nothing was run.`);
    process.exit(1);
  }
}
const URL_BASE = setting("EXECWARD_TEST_URL", "test-worker-url");
const SECRET = setting("EXECWARD_TEST_SECRET", "test-worker-secret");
const capFlag = process.argv.indexOf("--cap");
const CAP_USD = capFlag === -1 ? 1 : Number(process.argv[capFlag + 1]);
if (!(CAP_USD > 0 && CAP_USD <= 1)) throw new Error("the cap must be above 0 and at most 1 dollar");

const REPO = process.env.EXECWARD_TEST_REPO ?? "jared0565/execward";

/** List prices per million tokens, used only when the route reports no cost (src/eval/targets.ts). */
const MODELS = [
  {
    name: "Claude Haiku 5.5",
    provider: DIRECT ? anthropicProvider({ model: "claude-haiku-5-5" }) : openRouterProvider({ model: "anthropic/claude-haiku-5.5", upstream: "anthropic" }),
    price: { input: 0.1, output: 0.5 },
  },
  {
    name: "GPT-6 Luna",
    provider: DIRECT ? openAIProvider({ model: "gpt-6-luna" }) : openRouterProvider({ model: "openai/gpt-6-luna", upstream: "openai" }),
    price: { input: 0.1, output: 0.5 },
  },
] as const;

const TASKS: readonly { id: string; ask: string; expect: RegExp }[] = [
  { id: "default-branch", ask: `What is the default branch of the GitHub repository ${REPO}?`, expect: /\bmain\b/ },
  { id: "wrangler-version", ask: `In the GitHub repository ${REPO}, which exact version of the "wrangler" package does package.json on the default branch pin?`, expect: /4\.166\.0/ },
  { id: "pull-count", ask: `In the GitHub repository ${REPO}, how many of the 10 most recently created pull requests (in any state) are merged? Reply with the number.`, expect: /\b10\b/ },
];

let spentUsd = 0;

function metered(model: ModelProvider, price: { input: number; output: number }): ModelProvider {
  return {
    ...model,
    async turn(request) {
      if (spentUsd >= CAP_USD) throw new Error(`the spending cap of $${CAP_USD} was reached`);
      const turn = await model.turn(request);
      spentUsd += turn.usage.reportedCostUsd ?? (turn.usage.inputTokens * price.input + turn.usage.outputTokens * price.output) / 1_000_000;
      return turn;
    },
  };
}

/** The `code` tool, served by the deployed test Worker. The retry count stays here, with the app. */
const remoteCodeTool: CodeToolService = async (rawInput, caller) => {
  const blocked = caller.attempts.blocked();
  let output: CodeToolOutput;
  if (blocked) {
    output = {
      status: "refused",
      error: blocked,
      report: {
        runId: "not-run",
        scriptHash: "0".repeat(64),
        callsByTool: {},
        recordsRead: 0,
        recordsWritten: 0,
        errors: [blocked],
        retries: caller.attempts.retries(),
        assertions: { passed: 0, failed: 0 },
        sideEffects: [],
        verification: "not_applicable",
        durationMs: 0,
      },
    };
  } else {
    const response = await fetch(`${URL_BASE}/github`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ input: rawInput }) });
    if (!response.ok) throw new Error(`the test Worker answered ${response.status}`);
    const reply = (await response.json()) as { output: unknown; credentialInReply: boolean };
    if (reply.credentialInReply) throw new Error("the credential was found in a reply");
    output = codeToolOutputSchema.parse(reply.output);
  }
  await caller.attempts.settle(output);
  return output;
};

let failed = false;
for (const model of MODELS) {
  for (const task of TASKS) {
    const before = spentUsd;
    const escalated: string[] = [];
    const result = await runAppTask(task.ask, {
      model: metered(model.provider, model.price),
      codeTool: remoteCodeTool,
      direct: { definitions: [], call: async () => Promise.reject(new Error("direct calls are off in this run")) },
      codeMode: () => true,
      project: "work",
      providerRoute: "unknown",
      maxTurns: 8,
      onEscalate: (escalation) => void escalated.push(`${escalation.reason}: ${escalation.error.code}`),
    });
    const correct = result.stopped === "answered" && task.expect.test(result.answer);
    if (!correct) failed = true;
    console.log(
      JSON.stringify({
        model: model.name,
        route: DIRECT ? "direct" : "openrouter",
        task: task.id,
        correct,
        stopped: result.stopped,
        // A provider's error can carry a link that names the account. Links are not kept.
        ...(result.detail === undefined ? {} : { detail: result.detail.replace(/https?:\/\/\S+/g, "[link removed]").slice(0, 200) }),
        answer: result.answer.slice(0, 300),
        turns: result.turns,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: Number((spentUsd - before).toFixed(6)),
        codeRuns: result.reports.length,
        runs: result.reports.map((report) => ({ calls: report.callsByTool, errors: report.errors.map((error) => `${error.code}: ${error.message.slice(0, 120)}`), retries: report.retries, recordsRead: report.recordsRead })),
        unsupportedFigures: result.reconciliation.unsupported,
        escalated,
      }),
    );
  }
}
console.log(JSON.stringify({ totalCostUsd: Number(spentUsd.toFixed(6)), capUsd: CAP_USD }));
process.exit(failed ? 2 : 0);
