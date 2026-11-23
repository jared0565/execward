/**
 * Measures the latency the core adds to a run (task 1.9.4), on the deployed
 * test Worker.
 *
 *   npm run measure:latency            40 samples of each case
 *   npm run measure:latency -- 100     100 samples of each case
 *
 * Each case is timed from this machine. The baseline is a request the test
 * Worker refuses at its gate, which costs the network and the Worker's start
 * and nothing else. A case's added latency is its time less the baseline's.
 * The Worker's own figure for the run (`durationMs`) is reported beside it;
 * a Worker's clock only moves when it waits, so that figure leaves out
 * processor time.
 *
 * The address and test secret are read as the deployed tests read them.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

const URL_BASE = setting("EXECWARD_TEST_URL", "test-worker-url");
const SECRET = setting("EXECWARD_TEST_SECRET", "test-worker-secret");
const SAMPLES = Number(process.argv[2] ?? 40);

interface Case {
  readonly name: string;
  readonly route: string;
  readonly body: unknown;
  readonly authorised: boolean;
}

const calls = (count: number): string => `let last;\nfor (let i = 0; i < ${count}; i++) last = await tools.test_echo({ i });\nreturn last.args.i;`;

const CASES: readonly Case[] = [
  { name: "baseline: refused at the gate", route: "/code-tool", body: {}, authorised: false },
  { name: "script with no tool call", route: "/code-tool", body: { script: "return 1 + 1;", project: "work" }, authorised: true },
  { name: "script with 1 tool call", route: "/code-tool", body: { script: calls(1), project: "work" }, authorised: true },
  { name: "script with 10 tool calls", route: "/code-tool", body: { script: calls(10), project: "work" }, authorised: true },
  { name: "script with 50 tool calls", route: "/code-tool", body: { script: calls(50), project: "work" }, authorised: true },
  { name: "refused by the static check", route: "/code-tool", body: { script: `return fetch("https://example.com");`, project: "work" }, authorised: true },
];

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

async function sample(item: Case): Promise<{ ms: number; inside?: number }> {
  const started = performance.now();
  const response = await fetch(`${URL_BASE}${item.route}`, {
    method: "POST",
    headers: item.authorised ? { authorization: `Bearer ${SECRET}` } : {},
    body: JSON.stringify(item.body),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  if (item.authorised !== response.ok) throw new Error(`"${item.name}" answered ${response.status}`);
  if (!item.authorised) return { ms };
  const inside = (JSON.parse(text) as { output?: { report?: { durationMs?: number } } }).output?.report?.durationMs;
  return typeof inside === "number" ? { ms, inside } : { ms };
}

const rows: { name: string; median: number; p95: number; inside: number }[] = [];
for (const item of CASES) {
  // Two unmeasured requests first, so a cold start is not counted.
  await sample(item);
  await sample(item);
  const taken: number[] = [];
  const inside: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const one = await sample(item);
    taken.push(one.ms);
    if (one.inside !== undefined) inside.push(one.inside);
  }
  taken.sort((a, b) => a - b);
  inside.sort((a, b) => a - b);
  rows.push({ name: item.name, median: quantile(taken, 0.5), p95: quantile(taken, 0.95), inside: quantile(inside, 0.5) });
}

const baseline = rows[0];
if (!baseline) throw new Error("no baseline");
console.log(`${SAMPLES} samples of each case, one at a time, after two warm-up requests.\n`);
console.log("| Case | Median | 95th percentile | Added over baseline (median) | Worker's own figure (median) |");
console.log("|---|---|---|---|---|");
for (const row of rows) {
  const added = row === baseline ? "—" : `${Math.round(row.median - baseline.median)} ms`;
  const inside = Number.isNaN(row.inside) ? "—" : `${Math.round(row.inside)} ms`;
  console.log(`| ${row.name} | ${Math.round(row.median)} ms | ${Math.round(row.p95)} ms | ${added} | ${inside} |`);
}
