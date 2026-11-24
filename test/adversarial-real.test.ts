/**
 * The adversarial suite against ExecWard itself (FR-31, Gate 1), in the local
 * Workers runtime, on this commit's own code. The same run on Cloudflare, where
 * the sandbox is hardened, is test/deployed/adversarial.deployed.ts.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { ADVERSARIAL_CASES, JUDGED_FROM_THE_BUILD, OPEN_UNTIL_LATER, runSuite } from "../src/adversarial";
import { STOPPED_BY, unexpected, type ObservedResult } from "../src/adversarial/expected";
import { buildFacts, buildTarget } from "../scripts/build-facts";

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let results: ObservedResult[];

beforeAll(async () => {
  worker = await unstable_startWorker({ config: "test/workers/wrangler.jsonc", dev: { server: { port: 0 }, inspector: false, logLevel: "error" } });
  const response = await worker.fetch("http://harness.invalid/adversarial", { method: "POST", body: "{}" });
  results = ((await response.json()) as { results: ObservedResult[] }).results;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
});

describe("the adversarial suite against ExecWard (FR-31, Gate 1)", () => {
  it("runs every case but the ones judged from the build", () => {
    expect(results.map((result) => result.id)).toEqual(ADVERSARIAL_CASES.filter((item) => !JUDGED_FROM_THE_BUILD.includes(item.id)).map((item) => item.id));
  });

  it("serves both controls, so nothing passes by refusing everything", () => {
    expect(results.filter((result) => result.kind === "control").map((result) => [result.id, result.defended])).toEqual([
      ["control-allowed-read", true],
      ["control-caught-tool-error", true],
    ]);
  });

  it("defends every attack on a part that exists, each by the control meant for it", () => {
    expect(unexpected(results)).toEqual([]);
    const defended = results.filter((result) => result.kind === "attack" && result.defended).length;
    expect(defended).toBe(ADVERSARIAL_CASES.filter((item) => item.kind === "attack").length - JUDGED_FROM_THE_BUILD.length - Object.keys(OPEN_UNTIL_LATER).length);
  });

  it("names, for every attack still open, a task that is not finished", () => {
    const tasks = readFileSync("TASKS.md", "utf8");
    const ids = new Set(ADVERSARIAL_CASES.map((item) => item.id));
    for (const [id, { task }] of Object.entries(OPEN_UNTIL_LATER)) {
      expect(ids.has(id), id).toBe(true);
      const row = tasks.split("\n").find((line) => line.startsWith(`| ${task} |`));
      expect(row, `task ${task} for "${id}"`).toBeDefined();
      expect(row?.trimEnd().endsWith("| Done |"), `task ${task} is Done but "${id}" is still listed as open`).toBe(false);
    }
  });

  it("knows what stops each script attack, and only for cases that exist", () => {
    const ids = new Set(ADVERSARIAL_CASES.map((item) => item.id));
    for (const id of Object.keys(STOPPED_BY)) expect(ids.has(id), id).toBe(true);
  });

  it("reports a problem when an attack gets through, a control is refused, or an attack is stopped for the wrong reason", () => {
    const tampered = (change: (result: ObservedResult) => ObservedResult) => unexpected(results.map(change));
    expect(tampered((result) => (result.id === "unclassified-tool" ? { ...result, defended: false } : result))).toHaveLength(1);
    expect(tampered((result) => (result.id === "control-allowed-read" ? { ...result, defended: false } : result))).toHaveLength(1);
    expect(tampered((result) => (result.id === "host-call-cap" ? { ...result, runs: [{ status: "error", errorCode: "schema_invalid" }] } : result))).toHaveLength(1);
    expect(tampered((result) => (result.id === "model-saves-script" ? { ...result, defended: true } : result))).toHaveLength(1);
  });

  it("judges the supply-chain case from the build: a lockfile and exact versions", async () => {
    const facts = buildFacts();
    expect(facts.lockfile).toBe(true);
    expect(facts.exactVersions).toBe(true);
    // The SBOM is made by `npm run sbom`, which CI runs after the tests; the full case is judged by `npm run adversarial:real`.
    const [result] = await runSuite({ ...buildTarget(), supplyChain: async () => ({ ...facts, sbom: true }) }, ADVERSARIAL_CASES.filter((item) => item.id === "supply-chain-pins"));
    expect(result?.defended).toBe(true);
  });
});
