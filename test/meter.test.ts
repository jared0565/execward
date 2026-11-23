import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import type { Executor } from "../src/executor";
import { approximateTokenizer, estimatedSaving, memoryMeterSink, meter, METER_LEVELS, type MeterLevel, type MeterSink, type Tokenizer } from "../src/meter/meter";

/** Counts words, so the expected figures can be read off the test. Also counts how often it ran. */
function wordTokenizer(): Tokenizer & { runs: number } {
  const tokenizer = {
    name: "words",
    runs: 0,
    count(text: string) {
      tokenizer.runs += 1;
      return text.split(/\s+/).filter(Boolean).length;
    },
  };
  return tokenizer;
}

const RUN = { runId: "run-1", project: "demo" };

describe("the meter's measures (the PRD's token metering table)", () => {
  it("computes the estimated saving: kept-out plus definitions not loaded, minus script, returned and discovery", () => {
    expect(estimatedSaving({ keptOutTokens: 5_000, definitionsNotLoadedTokens: 1_200, scriptTokens: 150, returnedTokens: 40, discoveryTokens: 60 })).toBe(5_950);
    // A tiny task can cost more than it saves. The figure is not floored at zero.
    expect(estimatedSaving({ keptOutTokens: 10, definitionsNotLoadedTokens: 0, scriptTokens: 150, returnedTokens: 40, discoveryTokens: 0 })).toBe(-180);
  });

  it("counts each measure from what happened in the run", async () => {
    const sink = memoryMeterSink();
    const tokenizer = wordTokenizer();
    const run = meter({ level: "summary", sink, tokenizer, catalogTypings: () => "one two three four five six seven eight nine ten" }).start(RUN);
    run.toolResult("github_list_issues", "a b c d e f");
    run.toolResult("github_get_commit", "g h");
    run.discovery("search", "x y z");
    run.discovery("describe", { typing: "t1 t2 t3 t4" });
    const record = await run.finish({ script: "s1 s2 s3", returned: "r1 r2" });
    expect(record).toEqual({
      runId: "run-1",
      project: "demo",
      level: "summary",
      estimated: true,
      tokenizer: "words",
      scriptTokens: 3,
      returnedTokens: 2,
      keptOutTokens: 8,
      // "x y z" is 3; the describe result as JSON is one unbroken word plus the three after it.
      discoveryTokens: 3 + 4,
      // Ten in the catalog, four fetched through describe().
      definitionsNotLoadedTokens: 6,
      estimatedSavingTokens: 8 + 6 - 3 - 2 - 7,
    });
    expect(sink.records).toEqual([record]);
  });

  it("counts a value that is not text by its JSON", async () => {
    const sink = memoryMeterSink();
    const run = meter({ level: "summary", sink }).start(RUN);
    run.toolResult("github_list_issues", [{ number: 1 }, { number: 2 }]);
    const record = await run.finish({ script: "return 1;", returned: { count: 2 } });
    expect(record?.keptOutTokens).toBe(approximateTokenizer.count('[{"number":1},{"number":2}]'));
    expect(record?.returnedTokens).toBe(approximateTokenizer.count('{"count":2}'));
  });

  it("never reports fewer than zero definitions not loaded", async () => {
    const run = meter({ level: "summary", sink: memoryMeterSink(), tokenizer: wordTokenizer(), catalogTypings: () => "a b" }).start(RUN);
    run.discovery("describe", { typing: "a b c d e" });
    expect((await run.finish({ script: "s", returned: "r" }))?.definitionsNotLoadedTokens).toBe(0);
  });

  it("uses a rough count by default and names it in the record", async () => {
    expect(approximateTokenizer.count("")).toBe(0);
    expect(approximateTokenizer.count("abcd")).toBe(1);
    expect(approximateTokenizer.count("abcde")).toBe(2);
    // Counted in bytes, so text outside ASCII is not undercounted.
    expect(approximateTokenizer.count("é".repeat(4))).toBe(2);
    const record = await meter({ level: "summary", sink: memoryMeterSink() }).start(RUN).finish({ script: "return 1;", returned: 1 });
    expect(record?.tokenizer).toBe("approximate (1 token per 4 bytes)");
  });
});

describe("metering levels (FR-19)", () => {
  it("has three levels", () => {
    expect(METER_LEVELS).toEqual(["off", "summary", "detailed"]);
  });

  it("runs no tokenizer when off, and touches neither the catalog nor the sink", async () => {
    const tokenizer = wordTokenizer();
    let catalogRead = 0;
    const sink: MeterSink = { write: async () => Promise.reject(new Error("the sink must not be used")) };
    const run = meter({ level: "off", sink, tokenizer, catalogTypings: () => (catalogRead++, "a b c") }).start(RUN);
    run.toolResult("github_list_issues", "a b c");
    run.discovery("search", "a b c");
    expect(await run.finish({ script: "return 1;", returned: "a b c" })).toBeUndefined();
    expect(tokenizer.runs).toBe(0);
    expect(catalogRead).toBe(0);
  });

  it("writes one record per run at summary, with no per-call detail", async () => {
    const sink = memoryMeterSink();
    const run = meter({ level: "summary", sink }).start(RUN);
    run.toolResult("github_list_issues", "abcd");
    await run.finish({ script: "return 1;", returned: 1 });
    expect(sink.records.length).toBe(1);
    expect("calls" in sink.records[0]!).toBe(false);
  });

  it("adds sizes per tool call at detailed, and never content", async () => {
    const sink = memoryMeterSink();
    const run = meter({ level: "detailed", sink }).start(RUN);
    run.toolResult("github_get_file", "CONTENT-OF-A-PRIVATE-FILE");
    run.toolResult("github_list_issues", [1, 2, 3]);
    await run.finish({ script: "return 1;", returned: "RETURNED-TEXT" });
    expect(sink.records[0]?.calls).toEqual([
      { path: "github_get_file", resultBytes: 25, resultTokens: 7 },
      { path: "github_list_issues", resultBytes: 7, resultTokens: 2 },
    ]);
    const stored = JSON.stringify(sink.records);
    expect(stored).not.toContain("CONTENT-OF-A-PRIVATE-FILE");
    expect(stored).not.toContain("RETURNED-TEXT");
  });

  it("labels every record estimated, at both levels", async () => {
    for (const level of ["summary", "detailed"] as const) {
      const record = await meter({ level, sink: memoryMeterSink() }).start(RUN).finish({ script: "return 1;", returned: 1 });
      expect(record?.estimated, level).toBe(true);
    }
  });

  it("carries labels for grouping reports", async () => {
    const record = await meter({ level: "summary", sink: memoryMeterSink(), labels: { client: "test-app", model: "a-model" } }).start(RUN).finish({ script: "s", returned: 1 });
    expect(record?.labels).toEqual({ client: "test-app", model: "a-model" });
  });

  it("reads the catalog once, however many runs there are", async () => {
    let catalogRead = 0;
    const factory = meter({ level: "summary", sink: memoryMeterSink(), catalogTypings: () => (catalogRead++, "a b c") });
    for (let n = 0; n < 3; n++) await factory.start(RUN).finish({ script: "s", returned: 1 });
    expect(catalogRead).toBe(1);
  });
});

describe("the meter cannot affect a run (FR-19)", () => {
  const HOST: RunHost = {
    async callTool(path) {
      if (path === "github_missing") throw new Error("upstream_error: not found");
      return { from: path, rows: [1, 2, 3] };
    },
    search: async () => ["github_list_issues"],
    describe: async () => ({ typing: "github_list_issues(args: {}): Promise<unknown>;" }),
    provenance: () => ({ dataClass: undefined, records: 3 }),
  };
  const executor: Executor = {
    name: "scripted",
    async execute(request) {
      await request.host.search("issues");
      await request.host.describe("github_list_issues");
      await request.host.callTool("github_list_issues", {});
      await request.host.callTool("github_missing", {}).catch(() => undefined);
      return { status: "completed", result: { count: 3 }, logs: ["done"], truncated: false };
    },
  };

  function run(level: MeterLevel, overrides: { sink?: MeterSink; tokenizer?: Tokenizer; host?: RunHost } = {}) {
    const sink = memoryMeterSink();
    const store = memoryAuditStore();
    const output = runCodeTool(
      { script: "return 1;", project: "demo" },
      { executor, audit: auditLog(store, () => 0), hostFor: () => overrides.host ?? HOST, newRunId: () => "run-1", now: () => 0, meter: meter({ level, sink: overrides.sink ?? sink, ...(overrides.tokenizer ? { tokenizer: overrides.tokenizer } : {}) }) },
    );
    return { output, sink, store };
  }

  it("adds nothing to what the model sees: the reply is the same at every level", async () => {
    const off = await run("off").output;
    expect(await run("summary").output).toEqual(off);
    expect(await run("detailed").output).toEqual(off);
    expect(JSON.stringify(off)).not.toMatch(/token/i);
  });

  it("writes the same audit log at every level", async () => {
    const off = run("off");
    const detailed = run("detailed");
    await off.output;
    await detailed.output;
    expect(detailed.store.entries.map((entry) => entry.content)).toEqual(off.store.entries.map((entry) => entry.content));
  });

  it("meters a real run: tool results, discovery, script and the returned value", async () => {
    const { output, sink } = run("detailed");
    await output;
    expect(sink.records.length).toBe(1);
    const record = sink.records[0]!;
    expect(record).toMatchObject({ runId: "run-1", project: "demo", estimated: true, scriptTokens: approximateTokenizer.count("return 1;"), returnedTokens: approximateTokenizer.count('{"count":3}') });
    // Only the call that answered is counted; the failed one returned nothing to keep out.
    expect(record.calls).toEqual([{ path: "github_list_issues", resultBytes: 44, resultTokens: 11 }]);
    expect(record.keptOutTokens).toBe(11);
    expect(record.discoveryTokens).toBeGreaterThan(0);
  });

  it("does not fail the run when the sink fails", async () => {
    const { output } = run("summary", { sink: { write: async () => Promise.reject(new Error("disk full")) } });
    expect(await output).toMatchObject({ status: "completed", result: { count: 3 } });
  });

  it("does not fail the run when the tokenizer fails", async () => {
    const broken: Tokenizer = { name: "broken", count: () => { throw new Error("tokenizer crashed"); } };
    const { output, sink } = run("detailed", { tokenizer: broken });
    expect(await output).toMatchObject({ status: "completed", result: { count: 3 } });
    expect(sink.records).toEqual([]);
  });

  it("writes no record for a run that never started", async () => {
    const sink = memoryMeterSink();
    const output = await runCodeTool(
      { script: "return fetch('https://example.com');", project: "demo" },
      { executor, audit: auditLog(memoryAuditStore(), () => 0), hostFor: () => HOST, newRunId: () => "run-1", now: () => 0, meter: meter({ level: "detailed", sink }) },
    );
    expect(output.status).toBe("refused");
    expect(sink.records).toEqual([]);
  });
});
