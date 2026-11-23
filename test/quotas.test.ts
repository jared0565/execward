import { describe, expect, it } from "vitest";
import { brokerHost } from "../src/broker/broker";
import { memoryPolicyStore } from "../src/broker/policy-store";
import { admitRun, countCall, memoryQuotaStore, releaseRun, type QuotaContext, type QuotaStore } from "../src/broker/quotas";
import { runCodeTool } from "../src/code-tool/run";
import type { PolicyRecord } from "../src/contracts/policy";
import type { Executor } from "../src/executor";
import { CIRCUIT_BREAKER, PROJECT_QUOTAS, SPEND_CAPS } from "../src/limits";
import { record } from "./fixtures/policy";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A clock the test moves by hand. Starts well past the epoch, at the start of a window. */
function context(overrides: Partial<QuotaContext> = {}) {
  const clock = { now: 1_000 * DAY };
  const ctx: QuotaContext = { store: memoryQuotaStore(), project: "demo", now: () => clock.now, ...overrides };
  return { ctx, clock };
}

const BROKEN: QuotaStore = {
  add: async () => Promise.reject(new Error("store down")),
  acquire: async () => Promise.reject(new Error("store down")),
  release: async () => Promise.reject(new Error("store down")),
};

describe("admitting a run (FR-27)", () => {
  it("admits runs up to the per-minute limit, then refuses, then admits again in the next minute", async () => {
    const { ctx, clock } = context({ quotas: { ...PROJECT_QUOTAS, concurrentRuns: 1_000 } });
    for (let n = 0; n < PROJECT_QUOTAS.runsPerMinute; n++) expect(await admitRun(ctx, `run-${n}`, 1_000)).toBeUndefined();
    expect(await admitRun(ctx, "one-too-many", 1_000)).toEqual({ code: "quota_exceeded", message: "the project's limit of 10 runs a minute was reached" });
    clock.now += MINUTE;
    expect(await admitRun(ctx, "next-minute", 1_000)).toBeUndefined();
  });

  it("refuses more runs at once than the limit, and admits one when a run ends", async () => {
    const { ctx } = context();
    expect(await admitRun(ctx, "a", 1_000)).toBeUndefined();
    expect(await admitRun(ctx, "b", 1_000)).toBeUndefined();
    expect(await admitRun(ctx, "c", 1_000)).toEqual({ code: "quota_exceeded", message: "the project's limit of 2 runs at once was reached" });
    await releaseRun(ctx, "a");
    expect(await admitRun(ctx, "c", 1_000)).toBeUndefined();
  });

  it("frees the slot of a run that died without releasing it, once its time limit has passed", async () => {
    const { ctx, clock } = context();
    await admitRun(ctx, "a", 30_000);
    await admitRun(ctx, "b", 30_000);
    clock.now += 30_000 + MINUTE - 1;
    expect(await admitRun(ctx, "c", 30_000)).toMatchObject({ code: "quota_exceeded" });
    clock.now += 1;
    expect(await admitRun(ctx, "d", 30_000)).toBeUndefined();
  });

  it("refuses runs past the daily limit until the next day", async () => {
    const { ctx, clock } = context({ quotas: { runsPerMinute: 1_000, concurrentRuns: 1_000, runsPerDay: 3, upstreamCallsPerDay: 10 } });
    for (let n = 0; n < 3; n++) expect(await admitRun(ctx, `run-${n}`, 1_000)).toBeUndefined();
    expect(await admitRun(ctx, "over", 1_000)).toEqual({ code: "quota_exceeded", message: "the project's limit of 3 runs a day was reached" });
    clock.now += DAY;
    expect(await admitRun(ctx, "tomorrow", 1_000)).toBeUndefined();
  });

  it("stops at the daily spend cap", async () => {
    const open = { runsPerMinute: 1e9, concurrentRuns: 1e9, runsPerDay: 1e9, upstreamCallsPerDay: 1e9 };
    const { ctx } = context({ quotas: open, spend: { usdPerRun: 0.002, usdPerDay: 0.01, usdPerMonth: 100 } });
    // 0.01 / 0.002 = 5 runs, counted exactly: no rounding drift.
    for (let n = 0; n < 5; n++) expect(await admitRun(ctx, `run-${n}`, 1_000), `run ${n}`).toBeUndefined();
    expect(await admitRun(ctx, "over", 1_000)).toEqual({ code: "quota_exceeded", message: "the project's spend cap of $0.01 a day was reached" });
  });

  it("stops at the monthly spend cap even when each day is under its own cap", async () => {
    const open = { runsPerMinute: 1e9, concurrentRuns: 1e9, runsPerDay: 1e9, upstreamCallsPerDay: 1e9 };
    const { ctx, clock } = context({ quotas: open, spend: { usdPerRun: 1, usdPerDay: 2, usdPerMonth: 3 } });
    expect(await admitRun(ctx, "day1-a", 1_000)).toBeUndefined();
    expect(await admitRun(ctx, "day1-b", 1_000)).toBeUndefined();
    clock.now += DAY;
    expect(await admitRun(ctx, "day2-a", 1_000)).toBeUndefined();
    expect(await admitRun(ctx, "day2-b", 1_000)).toEqual({ code: "quota_exceeded", message: "the project's spend cap of $3 a month was reached" });
  });

  it("matches the default numbers: the daily spend cap is reached at the daily run limit", () => {
    expect(Math.round(SPEND_CAPS.usdPerDay / SPEND_CAPS.usdPerRun)).toBe(PROJECT_QUOTAS.runsPerDay);
  });

  it("keeps projects apart", async () => {
    const store = memoryQuotaStore();
    const one = context({ store, project: "one" }).ctx;
    const two = context({ store, project: "two" }).ctx;
    await admitRun(one, "a", 1_000);
    await admitRun(one, "b", 1_000);
    expect(await admitRun(one, "c", 1_000)).toMatchObject({ code: "quota_exceeded" });
    expect(await admitRun(two, "c", 1_000)).toBeUndefined();
  });

  it("refuses when the quota service is down", async () => {
    const { ctx } = context({ store: BROKEN });
    expect(await admitRun(ctx, "a", 1_000)).toEqual({ code: "quota_exceeded", message: "the quota service is unavailable" });
    expect(await countCall(ctx, "github_list_issues", undefined)).toBe("the quota service is unavailable");
    await expect(releaseRun(ctx, "a")).resolves.toBeUndefined();
  });
});

describe("run admission at the code tool (FR-27)", () => {
  const executor = (behaviour: () => Promise<never> | Promise<{ status: "completed"; result: unknown; logs: string[]; truncated: boolean }>): Executor => ({
    name: "scripted",
    execute: behaviour,
  });
  const host = { callTool: async () => 1, search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }) };

  function deps(ctx: QuotaContext, run: Executor) {
    let id = 0;
    return {
      executor: run,
      hostFor: () => host,
      newRunId: () => `run-${++id}`,
      now: () => 0,
      admission: {
        admit: (r: { runId: string; wallClockMs: number }) => admitRun(ctx, r.runId, r.wallClockMs),
        release: (r: { runId: string }) => releaseRun(ctx, r.runId),
      },
    };
  }

  it("refuses a run over quota before the script runs", async () => {
    const { ctx } = context({ quotas: { ...PROJECT_QUOTAS, runsPerMinute: 1 } });
    let executed = 0;
    const d = deps(ctx, executor(async () => (executed++, { status: "completed", result: 1, logs: [], truncated: false })));
    expect((await runCodeTool({ script: "return 1;", project: "demo" }, d)).status).toBe("completed");
    const second = await runCodeTool({ script: "return 1;", project: "demo" }, d);
    expect(second).toMatchObject({ status: "refused", error: { code: "quota_exceeded", message: "the project's limit of 1 runs a minute was reached" } });
    expect(executed).toBe(1);
  });

  it("releases the run's slot when it ends, including when the executor fails", async () => {
    const { ctx } = context({ quotas: { ...PROJECT_QUOTAS, concurrentRuns: 1 } });
    const failing = deps(ctx, executor(async () => Promise.reject(new Error("isolate lost"))));
    expect(await runCodeTool({ script: "return 1;", project: "demo" }, failing)).toMatchObject({ status: "error", error: { code: "sandbox_fault" } });
    const working = deps(ctx, executor(async () => ({ status: "completed", result: 1, logs: [], truncated: false })));
    expect((await runCodeTool({ script: "return 1;", project: "demo" }, working)).status).toBe("completed");
    expect((await runCodeTool({ script: "return 1;", project: "demo" }, working)).status).toBe("completed");
  });

  it("does not count a script that was refused by the static check", async () => {
    const { ctx } = context({ quotas: { ...PROJECT_QUOTAS, runsPerMinute: 1 } });
    const d = deps(ctx, executor(async () => ({ status: "completed", result: 1, logs: [], truncated: false })));
    expect((await runCodeTool({ script: "return fetch('x');", project: "demo" }, d)).status).toBe("refused");
    expect((await runCodeTool({ script: "return 1;", project: "demo" }, d)).status).toBe("completed");
  });

  it("refuses the run when the quota service throws", async () => {
    const d = {
      ...deps(context().ctx, executor(async () => ({ status: "completed", result: 1, logs: [], truncated: false }))),
      admission: { admit: async () => Promise.reject(new Error("down")), release: async () => undefined },
    };
    expect(await runCodeTool({ script: "return 1;", project: "demo" }, d)).toMatchObject({
      status: "refused",
      error: { code: "quota_exceeded", message: "the quota service is unavailable" },
    });
  });
});

describe("quotas on calls, at the broker (FR-27)", () => {
  function broker(tool: Partial<PolicyRecord>, extra: { quotas?: QuotaContext; fail?: () => boolean; limit?: number } = {}) {
    const upstreamCalls: string[] = [];
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues", tool), record("get_issue")]),
      upstream: async ({ record: called }) => {
        upstreamCalls.push(called.tool);
        if (extra.fail?.()) throw new Error("503 Service Unavailable");
        return "ok";
      },
      definitionFor: async () => ({ description: "test tool", inputSchema: { type: "object", additionalProperties: true } }),
      ...(extra.quotas ? { quotas: extra.quotas } : {}),
      ...(extra.limit === undefined ? {} : { consecutiveUpstreamErrors: extra.limit }),
    });
    return { host, upstreamCalls };
  }

  it("stops a tool at its per-run limit and ends the run", async () => {
    const { host, upstreamCalls } = broker({ quotas: { callsPerRun: 2 } });
    await host.callTool("github_list_issues", {});
    await host.callTool("github_list_issues", {});
    await expect(host.callTool("github_list_issues", {})).rejects.toThrow("quota_exceeded: the tool's limit of 2 calls in one run was reached");
    expect(upstreamCalls.length).toBe(2);
    expect(host.securityError()).toEqual({ code: "quota_exceeded", message: 'the call to "github_list_issues" was refused: the tool\'s limit of 2 calls in one run was reached' });
    await expect(host.callTool("github_get_issue", {})).rejects.toThrow("policy_denied: the run was ended by an earlier refusal");
  });

  it("stops a tool at its daily limit across runs, and a project at its daily call limit", async () => {
    const { ctx, clock } = context({ quotas: { ...PROJECT_QUOTAS, upstreamCallsPerDay: 4 } });
    const first = broker({ quotas: { callsPerDay: 2 } }, { quotas: ctx });
    await first.host.callTool("github_list_issues", {});
    await first.host.callTool("github_list_issues", {});
    // A new run, the same day: the tool's count carried over.
    const second = broker({ quotas: { callsPerDay: 2 } }, { quotas: ctx });
    await expect(second.host.callTool("github_list_issues", {})).rejects.toThrow("quota_exceeded: the tool's limit of 2 calls a day was reached");
    expect(second.upstreamCalls).toEqual([]);

    const third = broker({}, { quotas: ctx });
    await third.host.callTool("github_get_issue", {});
    await expect(third.host.callTool("github_get_issue", {})).rejects.toThrow("quota_exceeded: the project's limit of 4 upstream calls a day was reached");

    clock.now += DAY;
    const tomorrow = broker({ quotas: { callsPerDay: 2 } }, { quotas: ctx });
    await expect(tomorrow.host.callTool("github_list_issues", {})).resolves.toBe("ok");
  });

  it("does not count a call that policy refused", async () => {
    const { ctx } = context({ quotas: { ...PROJECT_QUOTAS, upstreamCallsPerDay: 1 } });
    const refusedRun = broker({}, { quotas: ctx });
    await expect(refusedRun.host.callTool("github_no_such_tool", {})).rejects.toThrow("policy_denied");
    await expect(broker({}, { quotas: ctx }).host.callTool("github_get_issue", {})).resolves.toBe("ok");
  });

  it("refuses calls when the quota service is down", async () => {
    const { host, upstreamCalls } = broker({}, { quotas: context({ store: BROKEN }).ctx });
    await expect(host.callTool("github_list_issues", {})).rejects.toThrow("quota_exceeded: the quota service is unavailable");
    expect(upstreamCalls).toEqual([]);
  });
});

describe("the circuit breaker (FR-27)", () => {
  function failing(pattern: boolean[]) {
    let call = 0;
    const upstreamCalls: number[] = [];
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues")]),
      upstream: async () => {
        upstreamCalls.push(call);
        if (pattern[call++]) throw new Error("503 Service Unavailable");
        return "ok";
      },
      definitionFor: async () => ({ description: "test tool", inputSchema: { type: "object", additionalProperties: true } }),
    });
    return { host, upstreamCalls };
  }
  const attempt = (host: { callTool(path: string, args: unknown): Promise<unknown> }) => host.callTool("github_list_issues", {}).catch((error: Error) => error.message);

  it("ends the run after five upstream errors in a row", async () => {
    const { host, upstreamCalls } = failing([true, true, true, true, true, false]);
    for (let n = 0; n < CIRCUIT_BREAKER.consecutiveUpstreamErrors - 1; n++) expect(await attempt(host)).toBe("upstream_error: 503 Service Unavailable");
    expect(host.securityError()).toBeUndefined();
    expect(await attempt(host)).toBe("circuit_open: 5 upstream errors in a row");
    expect(host.securityError()).toEqual({ code: "circuit_open", message: 'the call to "github_list_issues" was refused: 5 upstream errors in a row' });
    expect(await attempt(host)).toBe("policy_denied: the run was ended by an earlier refusal");
    expect(upstreamCalls.length).toBe(5);
  });

  it("starts counting again after a success", async () => {
    const { host } = failing([true, true, true, true, false, true, true, true, true, false]);
    for (let n = 0; n < 10; n++) await attempt(host);
    expect(host.securityError()).toBeUndefined();
  });

  it("counts a result the broker had to reject as an upstream error", async () => {
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues")]),
      upstream: async () => undefined,
      definitionFor: async () => ({ description: "test tool", inputSchema: { type: "object", additionalProperties: true } }),
      consecutiveUpstreamErrors: 2,
    });
    expect(await attempt(host)).toContain("schema_invalid");
    expect(await attempt(host)).toBe("circuit_open: 2 upstream errors in a row");
  });

  it("does not count the script's own mistakes", async () => {
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues")]),
      upstream: async () => "ok",
      definitionFor: async () => ({ description: "test tool", inputSchema: { type: "object", properties: {}, additionalProperties: false } }),
      consecutiveUpstreamErrors: 2,
    });
    for (let n = 0; n < 6; n++) await expect(host.callTool("github_list_issues", { wrong: true })).rejects.toThrow("schema_invalid");
    expect(host.securityError()).toBeUndefined();
  });
});
