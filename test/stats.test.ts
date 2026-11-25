import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { ownerConsole, type Principal } from "../src/console/console";
import { memoryControlStore } from "../src/console/control";
import { consoleResponse } from "../src/console/http";
import { consolePage } from "../src/console/page";
import { runMaintenance } from "../src/maintenance";
import type { MeterRecord } from "../src/meter/meter";
import { memoryStatsStore, STATS_KEEP_MS, STATS_MAX_GROUPS, STATS_NOTES, STATS_WINDOW_MS, statsReport, statsRowOf, type StatsRow } from "../src/meter/stats";
import { callerLabels, SESSION_HEADER } from "../src/mcp/production";

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 24 * 60 * 60_000;

const record = (over: Partial<MeterRecord> = {}): MeterRecord => ({
  runId: "run-1",
  project: "demo",
  level: "summary",
  estimated: true,
  tokenizer: "approximate",
  scriptTokens: 20,
  returnedTokens: 5,
  keptOutTokens: 900,
  discoveryTokens: 0,
  definitionsNotLoadedTokens: 400,
  estimatedSavingTokens: 1_275,
  labels: { client: "claude-code", model: "claude-fable-5-2", session: "s-1" },
  ...over,
});
const row = (over: Partial<StatsRow> = {}): StatsRow => ({ ...statsRowOf(record(), NOW), ...over });

describe("one run's row (task 2.3.1, FR-20)", () => {
  it("holds labels, a kind and counts, and nothing a script wrote or read", () => {
    const made = statsRowOf(record(), NOW, { inputTokens: 448, outputTokens: 84 });
    expect(made).toEqual({ runId: "run-1", at: NOW, project: "demo", session: "s-1", client: "claude-code", model: "claude-fable-5-2", kind: "bounded_tool_heavy", estimatedSavingTokens: 1_275, verified: true, verificationTokens: 532 });
  });

  it("puts a run that named no client or model under unknown, and groups one with no session by day", () => {
    const bare: MeterRecord = { ...record(), labels: {} };
    expect(statsRowOf(bare, NOW)).toMatchObject({ client: "unknown", model: "unknown", session: "day:2026-11-25", verified: false, verificationTokens: 0 });
  });

  it("never stores a figure that is not a whole number, or verification below nothing", () => {
    expect(statsRowOf(record({ estimatedSavingTokens: Number.NaN }), NOW, { inputTokens: -50, outputTokens: 1.4 })).toMatchObject({ estimatedSavingTokens: 0, verificationTokens: 0 });
  });
});

describe("the session label", () => {
  it("is the MCP session header when a client sends a plain one, and absent otherwise", () => {
    const labels = (value?: string) => callerLabels(new Request("https://mcp.example.test/mcp", { headers: value === undefined ? {} : { [SESSION_HEADER]: value } }));
    expect(labels("0b7c9e0e-3f8a-4f9c-9d2e-6a5a4d3c2b1a").session).toBe("0b7c9e0e-3f8a-4f9c-9d2e-6a5a4d3c2b1a");
    expect(labels().session).toBeUndefined();
    expect(labels("two words").session).toBeUndefined();
    expect(labels("x".repeat(200)).session).toBeUndefined();
  });
});

describe("the report", () => {
  async function filled() {
    const store = memoryStatsStore();
    await store.write(row({ runId: "a", project: "billing", client: "claude-code", model: "m-1", session: "s-1", estimatedSavingTokens: 1_000, verified: true, verificationTokens: 500 }));
    await store.write(row({ runId: "b", project: "billing", client: "codex", model: "m-2", session: "s-2", estimatedSavingTokens: -40, verified: false, verificationTokens: 0 }));
    await store.write(row({ runId: "c", project: "dashboard", client: "claude-code", model: "m-1", session: "s-1", estimatedSavingTokens: 300, verified: true, verificationTokens: 450 }));
    return store;
  }

  it("groups by session, project, client and model, busiest first, keeping estimated and measured apart", async () => {
    const report = await statsReport(await filled(), NOW);
    expect(Object.keys(report.by).sort()).toEqual(["client", "model", "project", "session"]);
    expect(report.by.project).toEqual([
      { key: "billing", runs: 2, estimated: { savingTokens: 960 }, measured: { verifiedRuns: 1, verificationTokens: 500 } },
      { key: "dashboard", runs: 1, estimated: { savingTokens: 300 }, measured: { verifiedRuns: 1, verificationTokens: 450 } },
    ]);
    expect(report.by.client).toEqual([
      { key: "claude-code", runs: 2, estimated: { savingTokens: 1_300 }, measured: { verifiedRuns: 2, verificationTokens: 950 } },
      { key: "codex", runs: 1, estimated: { savingTokens: -40 }, measured: { verifiedRuns: 0, verificationTokens: 0 } },
    ]);
    expect(report.by.model.map((group) => [group.key, group.runs])).toEqual([["m-1", 2], ["m-2", 1]]);
    expect(report.by.session.map((group) => [group.key, group.runs])).toEqual([["s-1", 2], ["s-2", 1]]);
  });

  it("shows no measured saving, and says why", async () => {
    const report = await statsReport(await filled(), NOW);
    expect(report.measuredSavingTokens).toBeNull();
    expect(report.notes).toBe(STATS_NOTES);
    expect(report.notes.join(" ")).toContain("No measured saving is shown");
    expect(report.notes.join(" ")).toContain("rough rule");
  });

  it("looks back thirty days and no further", async () => {
    const store = memoryStatsStore();
    await store.write(row({ runId: "old", at: NOW - STATS_WINDOW_MS - 1 }));
    await store.write(row({ runId: "edge", at: NOW - STATS_WINDOW_MS }));
    const report = await statsReport(store, NOW);
    expect(report).toMatchObject({ from: NOW - STATS_WINDOW_MS, to: NOW });
    expect(report.by.project).toEqual([expect.objectContaining({ runs: 1 })]);
  });

  it("counts a run once, however often it is written", async () => {
    const store = memoryStatsStore();
    await store.write(row({ runId: "a", estimatedSavingTokens: 100 }));
    await store.write(row({ runId: "a", estimatedSavingTokens: 999 }));
    expect((await statsReport(store, NOW)).by.project).toEqual([expect.objectContaining({ runs: 1, estimated: { savingTokens: 100 } })]);
  });

  it("shows at most fifty lines for one grouping", async () => {
    const store = memoryStatsStore();
    for (let index = 0; index < STATS_MAX_GROUPS + 5; index += 1) await store.write(row({ runId: `r-${index}`, session: `s-${index}` }));
    expect((await statsReport(store, NOW)).by.session).toHaveLength(STATS_MAX_GROUPS);
  });

  it("removes rows past their keeping time and keeps the rest", async () => {
    const store = memoryStatsStore();
    await store.write(row({ runId: "old", at: NOW - STATS_KEEP_MS - 1 }));
    await store.write(row({ runId: "kept", at: NOW - STATS_KEEP_MS }));
    await store.trim(NOW - STATS_KEEP_MS);
    expect([...store.rows.keys()]).toEqual(["kept"]);
    expect(STATS_KEEP_MS).toBe(90 * DAY);
  });
});

describe("the daily round", () => {
  it("trims the stats, and a trim that breaks stops nothing else", async () => {
    const trimmed: number[] = [];
    const base = { audit: memoryAuditStore(), queue: { expire: async () => [] }, escalations: { all: async () => [] }, now: () => NOW };
    const daily = await runMaintenance({ ...base, trimStats: async (now) => void trimmed.push(now) }, "daily");
    expect(daily.find((job) => job.job === "trim_stats")).toEqual({ job: "trim_stats", ok: true, detail: "trimmed" });
    expect(trimmed).toEqual([NOW]);
    const broken = await runMaintenance({ ...base, trimStats: async () => Promise.reject(new Error("no such table: meter_records")), sweepCounters: async () => undefined }, "daily");
    expect(broken.find((job) => job.job === "trim_stats")).toMatchObject({ ok: false });
    expect(broken.find((job) => job.job === "sweep_counters")).toMatchObject({ ok: true });
    expect((await runMaintenance({ ...base, trimStats: async () => undefined }, "frequent")).some((job) => job.job === "trim_stats")).toBe(false);
  });
});

describe("the console", () => {
  const owner: Principal = { kind: "owner", id: "o", twoFactorAt: NOW - 1000 };
  const ask = async (principal: Principal, connected = true) => {
    const store = memoryStatsStore();
    await store.write(row());
    const console_ = ownerConsole({ control: memoryControlStore(), audit: auditLog(memoryAuditStore(), () => NOW), now: () => NOW });
    return (await consoleResponse(new Request("https://console.example.test/console/stats"), { console: console_, principal, nonce: () => "n", ...(connected ? { stats: () => statsReport(store, NOW) } : {}) })) as Response;
  };

  it("gives the owner the report", async () => {
    const response = await ask(owner);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stats: { by: { project: unknown[] }; measuredSavingTokens: null } };
    expect(body.stats.by.project).toEqual([{ key: "demo", runs: 1, estimated: { savingTokens: 1_275 }, measured: { verifiedRuns: 0, verificationTokens: 0 } }]);
    expect(body.stats.measuredSavingTokens).toBeNull();
  });

  it("gives it to nobody else, and has no such address when no report is connected", async () => {
    expect((await ask({ kind: "anonymous" })).status).toBe(403);
    expect((await ask({ kind: "model_client", id: "mcp" })).status).toBe(403);
    expect((await ask(owner, false)).status).toBe(404);
  });

  it("shows it on the page under all four groupings", () => {
    const page = consolePage("n");
    expect(page).toContain('fetch("/console/stats")');
    for (const id of ["stats-project", "stats-client", "stats-model", "stats-session", "statsNotes"]) expect(page).toContain(`id="${id}"`);
  });
});
