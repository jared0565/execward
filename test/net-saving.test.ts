import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { memoryQuotaStore } from "../src/broker/quotas";
import { runCodeTool, type CodeToolDeps, type RunHost } from "../src/code-tool/run";
import { ownerConsole, type Principal } from "../src/console/console";
import { memoryControlStore } from "../src/console/control";
import { consoleResponse } from "../src/console/http";
import { consolePage } from "../src/console/page";
import type { Executor } from "../src/executor";
import { memoryMeterSink, meter } from "../src/meter/meter";
import { ADVICE, NET_SAVING_PERIOD_MS, netSavingLine, quotaNetSavingStore, runKindOf, type NetSavingEntry, type NetSavingReport } from "../src/meter/net-saving";
import type { ReviewVerdict } from "../src/verify/reviewer";

const NOW = 700 * NET_SAVING_PERIOD_MS + 5 * 24 * 60 * 60_000;
const entry = (keptOutTokens: number, discoveryTokens: number, estimatedSavingTokens: number, verification?: [number, number]): NetSavingEntry => ({
  record: { keptOutTokens, discoveryTokens, estimatedSavingTokens },
  ...(verification ? { verification: { inputTokens: verification[0], outputTokens: verification[1] } } : {}),
});

describe("the kind of a run, read from what it did (task 2.2.5)", () => {
  it.each([
    ["exploratory", 0, 40],
    ["exploratory", 900, 40],
    ["bounded_tool_heavy", 900, 0],
    ["no_tools", 0, 0],
  ] as const)("is %s with %i tool-result tokens and %i discovery tokens", (kind, keptOutTokens, discoveryTokens) => {
    expect(runKindOf({ keptOutTokens, discoveryTokens })).toBe(kind);
  });
});

describe("one line of the report", () => {
  const totals = { runs: 4, verifiedRuns: 2, estimatedSavingTokens: 1_000, verificationTokens: 300 };

  it("takes verification's tokens from the estimated saving", () => {
    expect(netSavingLine("bounded_tool_heavy", totals)).toEqual({ kind: "bounded_tool_heavy", ...totals, netSavingTokens: 700, flagged: false });
  });

  it("flags a kind whose verification uses more than Code Mode saves, and says to narrow it or switch it off", () => {
    const line = netSavingLine("bounded_tool_heavy", { ...totals, verificationTokens: 1_001 });
    expect(line).toMatchObject({ netSavingTokens: -1, flagged: true, advice: ADVICE.verification });
    expect(ADVICE.verification).toContain("Narrow what is verified");
    expect(ADVICE.verification).toContain("switch verification off");
  });

  it("says something different when Code Mode loses before any verification", () => {
    expect(netSavingLine("no_tools", { runs: 3, verifiedRuns: 0, estimatedSavingTokens: -90, verificationTokens: 0 })).toMatchObject({ netSavingTokens: -90, flagged: true, advice: ADVICE.codeMode });
  });

  it("does not flag a net saving of exactly nothing, or a kind with no runs", () => {
    expect(netSavingLine("exploratory", { ...totals, verificationTokens: 1_000 }).flagged).toBe(false);
    expect(netSavingLine("exploratory", { runs: 0, verifiedRuns: 0, estimatedSavingTokens: 0, verificationTokens: 0 })).toMatchObject({ flagged: false, netSavingTokens: 0 });
  });
});

describe("the kept totals", () => {
  it("adds runs up by kind, keeping the estimate and the provider's count apart", async () => {
    const store = quotaNetSavingStore(memoryQuotaStore());
    await store.add(entry(2_000, 0, 1_500, [450, 50]), NOW);
    await store.add(entry(1_000, 0, 600), NOW);
    await store.add(entry(0, 0, -30, [400, 40]), NOW);
    const report = await store.report(NOW);
    expect(report.savingIsEstimated).toBe(true);
    expect(report.lines).toEqual([
      { kind: "bounded_tool_heavy", runs: 2, verifiedRuns: 1, estimatedSavingTokens: 2_100, verificationTokens: 500, netSavingTokens: 1_600, flagged: false },
      { kind: "exploratory", runs: 0, verifiedRuns: 0, estimatedSavingTokens: 0, verificationTokens: 0, netSavingTokens: 0, flagged: false },
      { kind: "no_tools", runs: 1, verifiedRuns: 1, estimatedSavingTokens: -30, verificationTokens: 440, netSavingTokens: -470, flagged: true, advice: ADVICE.codeMode },
    ]);
  });

  it("says which period the totals are for, and starts again in the next one", async () => {
    const store = quotaNetSavingStore(memoryQuotaStore());
    await store.add(entry(2_000, 0, 1_500), NOW);
    const report = await store.report(NOW);
    expect(report.periodStart).toBe(700 * NET_SAVING_PERIOD_MS);
    expect(report.periodEnd - report.periodStart).toBe(NET_SAVING_PERIOD_MS);
    const later = await store.report(NOW + NET_SAVING_PERIOD_MS);
    expect(later.lines.every((line) => line.runs === 0)).toBe(true);
  });

  it("is shared: a second store on the same counters sees the first one's runs", async () => {
    const quotas = memoryQuotaStore();
    await quotaNetSavingStore(quotas).add(entry(500, 0, 200), NOW);
    expect((await quotaNetSavingStore(quotas).report(NOW)).lines[0]).toMatchObject({ runs: 1, estimatedSavingTokens: 200 });
  });

  it("never counts verification as less than nothing, or a figure that is not a number", async () => {
    const store = quotaNetSavingStore(memoryQuotaStore());
    await store.add(entry(500, 0, Number.NaN, [-900, 10]), NOW);
    expect((await store.report(NOW)).lines[0]).toMatchObject({ runs: 1, verifiedRuns: 1, estimatedSavingTokens: 0, verificationTokens: 0 });
  });
});

describe("the run path", () => {
  const host: RunHost = { callTool: async () => ({}), search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }) };
  const usage = { at: 0, purpose: "reviewer" as const, project: "demo", provider: "openai" as const, route: "openai_api_business" as const, model: "gpt-6-luna", inputTokens: 448, outputTokens: 84, measured: true as const, usdMicros: 87 };

  function setup(options: { readonly verdict?: ReviewVerdict; readonly level?: "off" | "summary"; readonly failing?: boolean } = {}) {
    const told: NetSavingEntry[] = [];
    const executor: Executor = { name: "scripted", execute: async () => ({ status: "completed", result: 5, logs: [], truncated: false }) };
    const deps: CodeToolDeps = {
      executor,
      audit: auditLog(memoryAuditStore(), () => 0),
      hostFor: () => host,
      newRunId: () => "run-1",
      now: () => 0,
      allowedDataClass: () => "internal",
      meter: meter({ sink: memoryMeterSink(), level: options.level ?? "summary" }),
      ...(options.verdict ? { review: async () => options.verdict as ReviewVerdict } : {}),
      netSaving: async (entry) => {
        if (options.failing) throw new Error("the counters are down");
        told.push(entry);
      },
    };
    return { deps, told };
  }
  const CALL = { script: "return 2 + 3;", project: "demo", criteria: ["The result is the number 5."] };

  it("reports a reviewed run with the provider's token counts", async () => {
    const { deps, told } = setup({ verdict: { outcome: "passed", usage } });
    await runCodeTool(CALL, deps);
    expect(told).toHaveLength(1);
    expect(told[0]?.verification).toEqual({ inputTokens: 448, outputTokens: 84 });
    expect(told[0]?.record).toMatchObject({ runId: "run-1", estimated: true });
  });

  it("reports a blocked run too: the reviewer's tokens were spent whatever it said", async () => {
    const { deps, told } = setup({ verdict: { outcome: "blocked", unmet: [1], usage } });
    expect(await runCodeTool(CALL, deps)).toMatchObject({ status: "error", error: { code: "review_blocked" } });
    expect(told[0]?.verification).toEqual({ inputTokens: 448, outputTokens: 84 });
  });

  it("reports a run that was not reviewed with no verification at all", async () => {
    const { deps, told } = setup();
    await runCodeTool(CALL, deps);
    expect(told).toHaveLength(1);
    expect(told[0]?.verification).toBeUndefined();
  });

  it("reports nothing when metering is off", async () => {
    const { deps, told } = setup({ level: "off", verdict: { outcome: "passed", usage } });
    await runCodeTool(CALL, deps);
    expect(told).toEqual([]);
  });

  it("does not fail a run when the figures cannot be kept", async () => {
    const { deps } = setup({ failing: true });
    expect(await runCodeTool(CALL, deps)).toMatchObject({ status: "completed", result: 5 });
  });
});

describe("the console", () => {
  const REPORT: NetSavingReport = { periodStart: 0, periodEnd: NET_SAVING_PERIOD_MS, savingIsEstimated: true, lines: [netSavingLine("no_tools", { runs: 1, verifiedRuns: 1, estimatedSavingTokens: -30, verificationTokens: 440 })] };
  const ask = (principal: Principal, withReport = true) => {
    const console_ = ownerConsole({ control: memoryControlStore(), audit: auditLog(memoryAuditStore(), () => NOW), now: () => NOW });
    return consoleResponse(new Request("https://console.example.test/console/saving"), { console: console_, principal, nonce: () => "n", ...(withReport ? { netSaving: async () => REPORT } : {}) }) as Promise<Response>;
  };
  const owner: Principal = { kind: "owner", id: "o", twoFactorAt: NOW - 1000 };

  it("gives the owner the report, flag and advice included", async () => {
    const response = await ask(owner);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saving: JSON.parse(JSON.stringify(REPORT)) });
  });

  it("gives it to nobody else", async () => {
    expect((await ask({ kind: "anonymous" })).status).toBe(403);
    expect((await ask({ kind: "model_client", id: "mcp" })).status).toBe(403);
  });

  it("has no such address when no report is connected", async () => {
    expect((await ask(owner, false)).status).toBe(404);
  });

  it("shows it on the page, saying which side is an estimate", () => {
    const page = consolePage("n");
    expect(page).toContain("Net saving after verification");
    expect(page).toContain('fetch("/console/saving")');
    expect(page).toContain("The saving is an estimate");
    expect(page).toContain("NEGATIVE");
  });
});
