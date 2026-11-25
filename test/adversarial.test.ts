import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_CASES,
  THREAT_ROWS,
  runSuite,
  stubTarget,
  summarise,
  uncoveredThreats,
} from "../src/adversarial";
import type { AdversarialCase, CaseResult, SuiteSummary, Target } from "../src/adversarial";

const attacks = ADVERSARIAL_CASES.filter((item) => item.kind === "attack");
const controls = ADVERSARIAL_CASES.filter((item) => item.kind === "control");

describe("adversarial cases (task 0.3.1)", () => {
  it("covers every row of the signed-off threat table", () => {
    expect(uncoveredThreats()).toEqual([]);
  });

  it("matches the number of rows in the threat table record", () => {
    const record = readFileSync("docs/decisions/0.1.10-threat-scores.md", "utf8");
    const rows = record.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    expect(rows).toHaveLength(THREAT_ROWS);
  });

  it("reports a row as uncovered when its cases are removed", () => {
    const without17 = ADVERSARIAL_CASES.filter((item) => !item.threats.includes(17));
    expect(uncoveredThreats(without17)).toEqual([17]);
  });

  it("gives every case a unique id, a threat row and a requirement", () => {
    const ids = ADVERSARIAL_CASES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of ADVERSARIAL_CASES) {
      expect(item.requirements.length, item.id).toBeGreaterThan(0);
      for (const requirement of item.requirements) expect(requirement, item.id).toMatch(/^FR-\d+$/);
      for (const row of item.threats) {
        expect(row, item.id).toBeGreaterThanOrEqual(1);
        expect(row, item.id).toBeLessThanOrEqual(THREAT_ROWS);
      }
    }
    for (const item of attacks) expect(item.threats.length, item.id).toBeGreaterThan(0);
  });

  it("covers every attack type FR-31 names", () => {
    const ids = new Set(ADVERSARIAL_CASES.map((item) => item.id));
    const named = [
      "injection-returned-unmarked", // injected tool results
      "poisoned-tool-description", // poisoned tool definitions
      "definition-changed-after-approval", // changed tool definitions
      "exfiltration-in-allowed-tool-arguments", // exfiltration through allowed tools
      "escape-constructor-chain", // sandbox escape
      "host-call-cap", // resource exhaustion
      "blocked-eval", // blocked script constructs
      "schema-violating-arguments", // schema-violating arguments
      "malformed-tool-result", // malformed results
      "reviewer-overrules-deterministic-fail", // reviewer injection
    ];
    for (const id of named) expect(ids.has(id), id).toBe(true);
  });

  it("holds no secret-shaped literal in its source", () => {
    for (const file of ["cases.ts", "fixtures.ts", "stub-target.ts"]) {
      const source = readFileSync(`src/adversarial/${file}`, "utf8");
      expect(source, file).not.toMatch(/gh[pousr]_[A-Za-z0-9]{36}/);
    }
  });

  it("counts an attack as open when the target offers no way to check it", async () => {
    const results = await runSuite({ name: "empty" });
    expect(results.filter((result) => result.defended)).toEqual([]);
  });

  it("counts a target that throws as not defended", async () => {
    const throwing: Target = {
      name: "throws",
      runScript: () => Promise.reject(new Error("boom")),
    };
    const first = attacks.find((item) => item.id === "host-call-cap") as AdversarialCase;
    const [result] = await runSuite(throwing, [first]);
    expect(result?.defended).toBe(false);
    expect(result?.detail).toContain("boom");
  });
});

describe("the suite against the stub (task 0.3.2)", () => {
  // Run as CI runs it, in a plain Node process: the test runner's own module
  // loader stops dynamic import in constructed code, which would hide one case.
  it("reports every attack as not defended, and serves every control", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/adversarial.ts", "--json"], {
      encoding: "utf8",
    });
    const report = JSON.parse(run.stdout) as { ok: boolean; summary: SuiteSummary; results: CaseResult[] };
    const results = report.results;
    const defendedAttacks = results.filter((result) => result.kind === "attack" && result.defended);
    const refusedControls = results.filter((result) => result.kind === "control" && !result.defended);
    expect(defendedAttacks.map((result) => `${result.id}: ${result.detail}`)).toEqual([]);
    expect(refusedControls.map((result) => `${result.id}: ${result.detail}`)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(run.status).toBe(0);
    expect(summarise(results)).toEqual({
      attacks: attacks.length,
      attacksDefended: 0,
      controls: controls.length,
      controlsServed: controls.length,
    });
    // It starts a whole Node process. On a busy machine that alone has taken longer than the default five seconds.
  }, 30_000);

  it("runs in CI on every change, with no path filter (task 0.3.3)", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("run: npm run adversarial");
    expect(workflow).toMatch(/^ {2}pull_request:\s*$/m);
    expect(workflow).not.toMatch(/^\s*paths(-ignore)?:/m);
    expect(workflow).not.toMatch(/^\s*if:/m);
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.adversarial).toBe("tsx scripts/adversarial.ts");
  });

  it("leaves no stand-in secret in the host environment afterwards", async () => {
    await runSuite(stubTarget());
    expect(process.env.EXECWARD_ADVERSARIAL_CANARY).toBeUndefined();
  });

  it("can tell a defence from its absence: a target that blocks calls passes those cases", async () => {
    const refusing: Target = {
      name: "refuses every script",
      runScript: () => Promise.resolve({ status: "refused", errorCode: "static_check_failed", logs: [] }),
    };
    const results = await runSuite(refusing);
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get("unclassified-tool")?.defended).toBe(true);
    expect(byId.get("blocked-eval")?.defended).toBe(true);
    // Refusing everything is not a pass: the controls catch it.
    expect(byId.get("control-allowed-read")?.defended).toBe(false);
  });
});
