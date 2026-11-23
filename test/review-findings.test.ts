/**
 * One test for each finding of the second-family review (task 1.9.7,
 * docs/reviews/1.9.7-sandbox-review.md), so that what was fixed stays fixed
 * and what was checked and found sound stays sound.
 */
import { describe, expect, it } from "vitest";
import { fakeToken } from "../src/adversarial/fixtures";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { brokerHost, SEARCH_LIMITS } from "../src/broker/broker";
import { checkAgainstSchema } from "../src/broker/json-schema";
import { memoryPolicyStore } from "../src/broker/policy-store";
import { memoryQuotaStore, type QuotaStore } from "../src/broker/quotas";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import type { Executor } from "../src/executor";
import { record } from "./fixtures/policy";

const ANY = { type: "object" };

/** A promise the test settles when it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("F1: a refused script that holds a secret", () => {
  it("is written to the audit log with the secret removed", async () => {
    const store = memoryAuditStore();
    const executor: Executor = { name: "never", execute: async () => ({ status: "completed", result: 1, logs: [], truncated: false }) };
    const token = fakeToken();
    const output = await runCodeTool(
      { script: `const key = "${token}";\nreturn 1;`, project: "demo" },
      { executor, audit: auditLog(store, () => 0), hostFor: () => ({ callTool: async () => 1, search: async () => [], describe: async () => ({}) }), newRunId: () => "run-1", now: () => 0 },
    );
    expect(output).toMatchObject({ status: "refused" });
    const written = JSON.stringify(await store.all());
    expect(written).toContain("run_refused");
    expect(written).not.toContain(token);
    expect(written).toContain("[redacted:");
  });
});

describe("F2: a call that is still being checked when its run ends", () => {
  function setup() {
    const gate = deferred<{ description: string; inputSchema: unknown }>();
    const sent: string[] = [];
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues")]),
      upstream: async ({ record: called }) => {
        sent.push(called.tool);
        return "ok";
      },
      definitionFor: () => gate.promise as never,
    });
    return { host, sent, release: () => gate.resolve({ description: "test tool", inputSchema: ANY }) };
  }

  it("is not sent upstream once the executor has closed the run", async () => {
    const { host, sent, release } = setup();
    const waiting = host.callTool("github_list_issues", {});
    host.close?.();
    release();
    await expect(waiting).rejects.toThrow("the run has ended");
    expect(sent).toEqual([]);
    // Closing is not a refusal: it is not reported as a security event.
    expect(host.securityError()).toBeUndefined();
  });

  it("is not sent upstream once a sibling call has been refused", async () => {
    const { host, sent, release } = setup();
    const waiting = host.callTool("github_list_issues", {});
    await expect(host.callTool("github_delete_everything", {})).rejects.toThrow("policy_denied");
    release();
    await expect(waiting).rejects.toThrow("policy_denied");
    expect(sent).toEqual([]);
  });

  it("does not hand over a result that arrives after the run ended", async () => {
    const answer = deferred<unknown>();
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues")]),
      upstream: () => answer.promise,
      definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
    });
    const waiting = host.callTool("github_list_issues", {});
    await new Promise((done) => setTimeout(done, 5));
    host.close?.();
    answer.resolve({ text: "late" });
    await expect(waiting).rejects.toThrow("the run has ended");
    expect(host.reads).toEqual([]);
  });
});

describe("F4: what a failing tool says", () => {
  function failing(overrides: Parameters<typeof record>[1]) {
    return brokerHost({
      store: memoryPolicyStore([record("get_file", overrides)]),
      upstream: async () => {
        throw Object.assign(new Error("CANARY-from-upstream"), { status: 404 });
      },
      definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
    });
  }

  it("is withheld for a sensitive tool, which gives only that it failed and the status", async () => {
    const host = failing({ sensitive: true, dataClass: "confidential" });
    const error = (await host.callTool("github_get_file", {}).catch((caught: Error) => caught)) as Error;
    expect(error.message).toContain("upstream_error: the tool failed with status 404");
    expect(error.message).not.toContain("CANARY");
    expect(host.reads).toEqual([]);
  });

  it("counts as data of the tool's class for any other tool", async () => {
    const host = failing({ dataClass: "confidential" });
    await expect(host.callTool("github_get_file", {})).rejects.toThrow("upstream_error: CANARY-from-upstream");
    expect(host.dataClass()).toBe("confidential");
    expect(host.provenance().records).toBe(0);
  });
});

describe("F5: a value that fits more than one branch of a schema", () => {
  it.each([
    ["the plain branch first", [{ type: "string" }, { type: "string", format: "uri" }]],
    ["the URL branch first", [{ type: "string", format: "uri" }, { type: "string" }]],
  ])("is checked as a URL with %s", (_label, anyOf) => {
    const checked = checkAgainstSchema({ to: "https://example.com/hook" }, { type: "object", properties: { to: { anyOf } } });
    expect(checked.problems).toEqual([]);
    expect(checked.located).toContainEqual({ kind: "url", value: "https://example.com/hook", at: expect.any(String) });
  });
});

describe("F8: a run whose result is withheld", () => {
  it("does not report how many assertions passed, and keeps the count in the audit log", async () => {
    const store = memoryAuditStore();
    const executor: Executor = { name: "scripted", execute: async () => ({ status: "completed", result: "x", logs: [], truncated: false, assertionsPassed: 7 }) };
    const host: RunHost = { callTool: async () => 1, search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: "confidential", records: 1 }) };
    const output = await runCodeTool(
      { script: "return 1;", project: "demo" },
      { executor, audit: auditLog(store, () => 0), hostFor: () => host, allowedDataClass: () => "public", newRunId: () => "run-1", now: () => 0 },
    );
    expect(output).toMatchObject({ status: "completed", masked: true, report: { assertions: { passed: 0 } } });
    expect((await store.all()).some((entry) => entry.content?.includes('"assertionsPassedWithheld":7'))).toBe(true);
  });
});

describe("F9: how much one discovery call may ask of the host", () => {
  const host = () =>
    brokerHost({ store: memoryPolicyStore([record("list_issues")]), upstream: async () => "ok", definitionFor: async () => ({ description: "test tool", inputSchema: ANY }) });

  it("refuses an oversized search as the script's mistake, not as a security event", async () => {
    const broker = host();
    await expect(broker.search("issue ".repeat(200))).rejects.toThrow("schema_invalid");
    expect(broker.securityError()).toBeUndefined();
    await expect(broker.search("x".repeat(SEARCH_LIMITS.maxQueryChars))).resolves.toEqual([]);
  });

  it("scores only the first words of a search, and does not look up an oversized name", async () => {
    const broker = host();
    const padding = Array.from({ length: SEARCH_LIMITS.maxWords }, (_, index) => `pad${index}`).join(" ");
    await expect(broker.search(`${padding} issues`)).resolves.toEqual([]);
    await expect(broker.search(`issues ${padding}`.slice(0, SEARCH_LIMITS.maxQueryChars))).resolves.toEqual(["github_list_issues"]);
    await expect(broker.describe("a".repeat(SEARCH_LIMITS.maxPathChars + 1))).rejects.toThrow("is available to scripts");
  });
});

describe("counting calls ahead, so a loop does not write a counter on every call (task 1.9.4)", () => {
  function setup(callsPerDay?: number) {
    const inner = memoryQuotaStore();
    const totals = new Map<string, number>();
    let writes = 0;
    const store: QuotaStore = {
      ...inner,
      async add(key, windowMs, amount, now) {
        writes++;
        const total = await inner.add(key, windowMs, amount, now);
        totals.set(key, total);
        return total;
      },
    };
    const newRun = () =>
      brokerHost({
        store: memoryPolicyStore([record("list_issues", { quotas: callsPerDay === undefined ? {} : { callsPerDay } })]),
        upstream: async () => "ok",
        definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
        quotas: { store, project: "demo", now: () => 1_000 },
      });
    return { newRun, totals, writes: () => writes };
  }

  it("writes far fewer counters than calls, and ends with exactly the calls made", async () => {
    const { newRun, totals, writes } = setup();
    const host = newRun();
    for (let call = 0; call < 50; call++) await host.callTool("github_list_issues", {});
    // Blocks of 1, 2, 4, 8, 16, 16, 16 cover 50 calls in seven writes.
    expect(writes()).toBe(7);
    expect(totals.get("calls:demo")).toBe(63);
    await host.close?.();
    expect(totals.get("calls:demo")).toBe(50);
  });

  it("meets a tool's daily limit exactly: not one call early, not one late", async () => {
    const { newRun, totals } = setup(5);
    const host = newRun();
    for (let call = 0; call < 5; call++) await expect(host.callTool("github_list_issues", {})).resolves.toBe("ok");
    await expect(host.callTool("github_list_issues", {})).rejects.toThrow("quota_exceeded");
    await host.close?.();
    // Five made, and the refused one stays counted, as a single refused call always has.
    expect(totals.get("calls:demo:github_list_issues")).toBe(6);
  });

  it("counts across runs: a second run sees what the first one used", async () => {
    const { newRun } = setup(5);
    const first = newRun();
    for (let call = 0; call < 3; call++) await first.callTool("github_list_issues", {});
    await first.close?.();
    const second = newRun();
    for (let call = 0; call < 2; call++) await expect(second.callTool("github_list_issues", {})).resolves.toBe("ok");
    await expect(second.callTool("github_list_issues", {})).rejects.toThrow("quota_exceeded");
  });
});
