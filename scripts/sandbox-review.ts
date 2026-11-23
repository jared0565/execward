/**
 * Asks a model from another family to review the sandbox against the threat
 * table (task 1.9.7). One paid call.
 *
 *   npx tsx scripts/sandbox-review.ts --cap 2 [--model gpt-6.2-astra] [--out docs/reviews/1.9.7-sandbox-review.json]
 *
 * --cap  US dollars. Required. The call is sized so that it cannot cost more.
 *
 * Sends source files from this repository and the threat table. Nothing else.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import OpenAI from "openai";

/** US dollars per million tokens, from the provider's price page on 2026-11-23. */
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "gpt-6.2-astra": { input: 8, output: 40 },
  "gpt-6.2-sol": { input: 2, output: 10 },
};

const FOLDERS = ["src/executor", "src/static-check", "src/broker"];
const FILES = ["src/code-tool/run.ts", "src/code-tool/present.ts", "src/code-tool/attempts.ts", "docs/decisions/1.2.2-limits-on-cloudflare.md"];
const THREATS = "docs/decisions/0.1.10-threat-scores.md";

const INSTRUCTIONS = `You are reviewing the security of a sandbox, written by another AI model, for flaws its author missed.

The system: an AI model writes a short JavaScript script. The script runs in a Cloudflare Dynamic Worker isolate with no network. Its only way out is a broker in the host, which checks every tool call against a policy table before calling the tool. All tools are read-only today. The script is untrusted: assume it is written by an attacker, or by a model following text an attacker planted in tool results.

You are given the threat table and the source. Review the source against the threats that code can address: sandbox escape, tool misuse as an exit, tool poisoning, hook and permission bypass, denial of service, unclassified tools, credential exposure, and leaking data across data classes.

Look for: ways a script reaches anything other than the broker; ways to call a tool the policy does not allow; ways to make the host run or evaluate script-controlled text; prototype pollution and property-name tricks across the boundary; ways to exhaust the host; ways to get past the static check that matter given the runtime checks; error paths that fail open; secrets or other tenants' data reaching a script or a result.

Be concrete. Cite the file and the function. Give a script or input that would show the flaw where you can. Do not report style. Do not report a missing feature as a flaw unless its absence breaks a control that exists. If you are not sure something is exploitable, say so and say what would settle it.

Reply with JSON only, no code fence:
{"summary": string, "findings": [{"id": "F1", "severity": "critical"|"high"|"medium"|"low"|"info", "threat": number or null, "file": string, "where": string, "title": string, "detail": string, "proof": string, "fix": string, "confidence": "high"|"medium"|"low"}], "checked_and_sound": [string], "not_reviewable_from_source": [string]}`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const cap = Number(option("cap"));
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("Cannot start: give a spend cap in US dollars, for example --cap 2");
  const model = option("model") ?? "gpt-6.2-astra";
  const price = PRICES[model];
  if (!price) throw new Error(`Cannot start: no price is recorded for ${model}`);
  const out = option("out") ?? "docs/reviews/1.9.7-sandbox-review.json";
  if (!process.env.OPENAI_API_KEY) throw new Error("Cannot start: OPENAI_API_KEY is not set");

  const paths = [...FOLDERS.flatMap((folder) => readdirSync(folder).filter((name) => name.endsWith(".ts")).sort().map((name) => join(folder, name).replaceAll("\\", "/"))), ...FILES];
  const input = [`# Threat table\n\n${readFileSync(THREATS, "utf8")}`, ...paths.map((path) => `# File: ${path}\n\n${readFileSync(path, "utf8")}`)].join("\n\n---\n\n");

  // Sized before the call: three characters a token is a high estimate for source code.
  const inputEstimate = Math.ceil((input.length + INSTRUCTIONS.length) / 3);
  const maxOutputTokens = Math.floor(((cap - (inputEstimate * price.input) / 1e6) * 1e6) / price.output);
  if (maxOutputTokens < 4000) throw new Error(`Cannot start: the cap leaves room for only ${maxOutputTokens} output tokens`);
  const outputLimit = Math.min(maxOutputTokens, 24_000);
  console.log(`${model}: ${paths.length} files, about ${inputEstimate} input tokens, at most ${outputLimit} output tokens, at most $${((inputEstimate * price.input + outputLimit * price.output) / 1e6).toFixed(2)}`);
  if (process.argv.includes("--dry-run")) return;

  const response = await new OpenAI().responses.create({ model, instructions: INSTRUCTIONS, input, max_output_tokens: outputLimit });
  const usage = response.usage;
  const costUsd = ((usage?.input_tokens ?? 0) * price.input + (usage?.output_tokens ?? 0) * price.output) / 1e6;
  const text = response.output_text;
  let review: unknown;
  try {
    review = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    review = { unparsed: text };
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ model: response.model, status: response.status, files: paths, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, costUsd, review }, null, 2)}\n`);
  console.log(`status ${response.status}; ${usage?.input_tokens} input and ${usage?.output_tokens} output tokens; $${costUsd.toFixed(4)}; written to ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
