/**
 * One test or more for each finding of the second review by another model
 * family (task 2.3.3, docs/reviews/2.3.3-sandbox-review.md), so that what was
 * fixed stays fixed.
 *
 * Elsewhere: F2 is in broker-results.test.ts, and F3 and the part of F5 that
 * was fixed are in executor-dynamic-worker.test.ts, because they need the
 * sandbox itself.
 */
import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { brokerHost } from "../src/broker/broker";
import { memoryPolicyStore, type PolicyStore } from "../src/broker/policy-store";
import { memoryQuotaStore, type QuotaStore } from "../src/broker/quotas";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import { memoryControlStore } from "../src/console/control";
import { escalationQueue, memoryEscalationStore } from "../src/console/escalations";
import type { Executor } from "../src/executor";
import { GOLDEN_REVIEW_CASES, quotaGoldenStore, runGoldenCheck } from "../src/verify/golden";
import { textWithin, type VerificationAccess } from "../src/verify/model-access";
import { REVIEW_CLOSE, REVIEW_OPEN, REVIEWER_LIMITS, reviewer, reviewMaterial, type ReviewInput, type ReviewVerdict } from "../src/verify/reviewer";
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

const tick = () => new Promise((done) => setTimeout(done, 2));

describe("F1: a project name the calling model made up", () => {
  const executorThatRan: string[] = [];
  const executor: Executor = {
    name: "scripted",
    execute: async () => {
      executorThatRan.push("ran");
      return { status: "completed", result: 1, logs: [], truncated: false };
    },
  };
  const host: RunHost = { callTool: async () => 1, search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }) };

  function run(project: string, projectKnown: (project: string) => Promise<boolean>) {
    const store = memoryAuditStore();
    const admitted: string[] = [];
    const output = runCodeTool(
      { script: "return 1;", project },
      {
        executor,
        audit: auditLog(store, () => 0),
        hostFor: () => host,
        projectKnown,
        admission: {
          admit: async (asked) => {
            admitted.push(asked.project);
            return undefined;
          },
          release: async () => undefined,
        },
        newRunId: () => "run-1",
        now: () => 0,
      },
    );
    return { output, store, admitted };
  }

  it("is refused before anything is counted or run, and the refusal is on record", async () => {
    executorThatRan.length = 0;
    const { output, store, admitted } = run("made-up-name-7", async (project) => project === "demo");
    const reply = await output;
    expect(reply).toMatchObject({ status: "refused", error: { code: "policy_denied" } });
    // The name is the caller's own text: it is not repeated back.
    expect(JSON.stringify(reply.status === "refused" ? reply.error : null)).not.toContain("made-up-name-7");
    expect(admitted).toEqual([]);
    expect(executorThatRan).toEqual([]);
    expect((await store.all()).map((entry) => entry.kind)).toEqual(["run_refused"]);
  });

  it("is refused when the record cannot be read", async () => {
    const { output } = run("demo", async () => {
      throw new Error("database down");
    });
    expect(await output).toMatchObject({ status: "refused", error: { code: "policy_denied" } });
  });

  it("does not stop a project that has a record", async () => {
    const { output, admitted } = run("demo", async (project) => project === "demo");
    expect(await output).toMatchObject({ status: "completed", result: 1 });
    expect(admitted).toEqual(["demo"]);
  });
});

describe("F6: calls to one tool started together", () => {
  it("are each counted once: the day's count ends at exactly the calls made", async () => {
    const inner = memoryQuotaStore();
    const totals = new Map<string, number>();
    const store: QuotaStore = {
      ...inner,
      async add(key, windowMs, amount, now) {
        // Every count waits, so calls started together are all waiting at once.
        await tick();
        const total = await inner.add(key, windowMs, amount, now);
        totals.set(key, total);
        return total;
      },
    };
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues")]),
      upstream: async () => "ok",
      definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
      quotas: { store, project: "demo", now: () => 1_000 },
    });
    await Promise.all(Array.from({ length: 6 }, () => host.callTool("github_list_issues", {})));
    // Then some one after another, which use what the first six counted ahead.
    for (let call = 0; call < 9; call++) await host.callTool("github_list_issues", {});
    await host.close?.();
    // Before the fix this ended below 15: calls were made on credit nobody had counted.
    expect(totals.get("calls:demo")).toBe(15);
  });

  it("cannot be used to get past a tool's daily limit", async () => {
    const inner = memoryQuotaStore();
    const store: QuotaStore = {
      ...inner,
      async add(key, windowMs, amount, now) {
        await tick();
        return inner.add(key, windowMs, amount, now);
      },
    };
    let sent = 0;
    const newRun = () =>
      brokerHost({
        store: memoryPolicyStore([record("list_issues", { quotas: { callsPerDay: 10 } })]),
        upstream: async () => {
          sent++;
          return "ok";
        },
        definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
        quotas: { store, project: "demo", now: () => 1_000 },
      });
    for (let run = 0; run < 4; run++) {
      const host = newRun();
      await Promise.allSettled(Array.from({ length: 5 }, () => host.callTool("github_list_issues", {})));
      for (let call = 0; call < 5; call++) await host.callTool("github_list_issues", {}).catch(() => undefined);
      await host.close?.();
    }
    expect(sent).toBeLessThanOrEqual(10);
  });
});

describe("F7: discovery in a run that is over", () => {
  it("stops a search once the run has closed, without looking anything up", async () => {
    const list = deferred<readonly ReturnType<typeof record>[]>();
    const lookedUp: string[] = [];
    const inner = memoryPolicyStore([record("list_issues"), record("get_license")]);
    const store: PolicyStore = { ...inner, list: () => list.promise };
    const host = brokerHost({
      store,
      upstream: async () => "ok",
      definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
      docsFor: async (path) => {
        lookedUp.push(path);
        return { typing: "issues" };
      },
    });
    const waiting = host.search("issues");
    await host.close?.();
    list.resolve(await inner.list());
    await expect(waiting).rejects.toThrow("the run has ended");
    expect(lookedUp).toEqual([]);
    expect(host.securityError()).toBeUndefined();
  });

  it("does not describe a tool once the run has closed", async () => {
    const docs = deferred<{ typing: string }>();
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues")]),
      upstream: async () => "ok",
      definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
      docsFor: () => docs.promise,
    });
    const waiting = host.describe("github_list_issues");
    await tick();
    await host.close?.();
    docs.resolve({ typing: "late" });
    await expect(waiting).rejects.toThrow("the run has ended");
  });
});

describe("F11: a sensitive read that lands while an outbound call waits", () => {
  it("stops the outbound call, although it was allowed when it was first checked", async () => {
    const quotaWait = deferred<void>();
    const inner = memoryQuotaStore();
    let hold = false;
    const store: QuotaStore = {
      ...inner,
      async add(key, windowMs, amount, now) {
        if (hold && key.endsWith("github_send_report")) await quotaWait.promise;
        return inner.add(key, windowMs, amount, now);
      },
    };
    const sent: string[] = [];
    const host = brokerHost({
      store: memoryPolicyStore([record("get_file", { dataClass: "confidential", sensitive: true }), record("send_report", { outbound: true, quotas: { callsPerDay: 100 } })]),
      upstream: async ({ record: called }) => {
        sent.push(called.tool);
        return "ok";
      },
      definitionFor: async () => ({ description: "test tool", inputSchema: ANY }),
      quotas: { store, project: "demo", now: () => 1_000 },
    });
    hold = true;
    // Nothing sensitive has been read yet, so the first look lets this through; it then waits to be counted.
    const outbound = host.callTool("github_send_report", {});
    await tick();
    hold = false;
    await host.callTool("github_get_file", {});
    quotaWait.resolve();
    await expect(outbound).rejects.toThrow("policy_denied");
    expect(sent).toEqual(["get_file"]);
    expect(host.securityError()?.message).toContain("has read sensitive data");
  });
});

describe("F4: what the reviewer is shown", () => {
  const INPUT: ReviewInput = {
    runId: "run-1",
    project: "demo",
    criteria: ["The result is the number 5."],
    output: 5,
    report: { runId: "run-1", scriptHash: "0".repeat(64), callsByTool: {}, recordsRead: 0, recordsWritten: 0, errors: [], retries: 0, assertions: { passed: 0, failed: 0 }, sideEffects: [], verification: "unreviewed", durationMs: 0 },
    dataClass: "public",
    deterministicCheckPassed: true,
    tier: 0,
  };
  const inside = (input: ReviewInput) => JSON.parse(reviewMaterial(input).slice(REVIEW_OPEN.length, -REVIEW_CLOSE.length)) as { output: unknown; outputWasCut: boolean };

  it("keeps the number 5 and the text 5 apart", () => {
    expect(inside(INPUT).output).toBe(5);
    expect(inside({ ...INPUT, output: "5" }).output).toBe("5");
    expect(reviewMaterial(INPUT)).not.toBe(reviewMaterial({ ...INPUT, output: "5" }));
  });

  // Seen on production on 2026-11-26, an hour after the first fix for this finding: the number was
  // sent as JSON text inside the JSON material, so it reached the reviewer in quotes, the
  // instructions said quotes mean text, and a right answer of 5 was blocked.
  it("shows the reviewer a number as a number, not in quotes", () => {
    const material = reviewMaterial(INPUT);
    expect(material).toMatch(/"output": ?5,/);
    expect(material).not.toMatch(/"output": ?"5"/);
    expect(inside({ ...INPUT, output: [12, 15, 18] }).output).toEqual([12, 15, 18]);
    expect(inside({ ...INPUT, output: undefined }).output).toBeNull();
  });

  const answering = (text: string): VerificationAccess => ({
    call: async (request) => ({
      text,
      metered: true,
      record: { at: 0, purpose: request.purpose, project: request.project, provider: "openai", route: "openai_api_business", model: request.model, inputTokens: 1, outputTokens: 1, measured: true, usdMicros: 1 },
    }),
  });
  const long = { ...INPUT, output: "x".repeat(REVIEWER_LIMITS.maxOutputChars + 10) };

  it("does not count a pass on an output it was sent only the start of", async () => {
    const verdict = await reviewer({ access: answering('{"verdict":"pass","unmet":[]}') }).review(long);
    expect(verdict).toMatchObject({ outcome: "unreviewed", reason: "output_cut" });
    expect(inside(long).outputWasCut).toBe(true);
  });

  it("still counts a block on the part it was sent", async () => {
    const verdict = await reviewer({ access: answering('{"verdict":"block","unmet":[1]}') }).review(long);
    expect(verdict).toMatchObject({ outcome: "blocked", unmet: [1] });
  });

  it("still counts a pass on an output it was sent whole", async () => {
    expect(await reviewer({ access: answering('{"verdict":"pass","unmet":[]}') }).review(INPUT)).toMatchObject({ outcome: "passed" });
  });
});

describe("F8: a day on which one case was answered wrongly and another could not be asked", () => {
  it("is a failed day, not a day that counts for nothing", async () => {
    const audit = memoryAuditStore();
    const escalations = memoryEscalationStore();
    const now = () => 20_000 * 24 * 60 * 60_000;
    const queue = escalationQueue({ store: escalations, control: memoryControlStore(), audit: auditLog(audit, now), now, newId: () => "esc-1" });
    const store = quotaGoldenStore(memoryQuotaStore());
    let asked = 0;
    const said = await runGoldenCheck({
      reviewer: {
        async review(): Promise<ReviewVerdict> {
          asked++;
          // The first case could not be asked. Every other one is passed, which is wrong for the cases that should be blocked.
          return asked === 1 ? { outcome: "unreviewed", reason: "reviewer_refused", detail: "budget_exceeded" } : { outcome: "passed" };
        },
      },
      store,
      queue,
      audit: auditLog(audit, now),
      now,
    });
    expect(asked).toBe(GOLDEN_REVIEW_CASES.length);
    expect(said).toContain("cases wrong; failed days in a row: 1");
    expect(await store.failedDays(now())).toBe(1);
    expect(JSON.stringify(audit.entries.at(-1)).replaceAll(String.fromCharCode(92), "")).toContain('"result":"failed"');
  });
});

describe("F9: reading the verification provider's reply", () => {
  const streamed = (pieces: readonly Uint8Array[], onCancel?: () => void) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = pieces[sent++];
          if (next === undefined) controller.close();
          else controller.enqueue(next);
        },
        cancel() {
          onCancel?.();
        },
      }),
    );
  let sent = 0;

  it("counts bytes, not characters", async () => {
    const text = "é".repeat(60);
    expect(text.length).toBe(60);
    expect(await textWithin(new Response(text), 100)).toBeUndefined();
    expect(await textWithin(new Response(text), 120)).toBe(text);
  });

  it("stops reading as soon as the limit is passed, and drops the rest", async () => {
    sent = 0;
    let cancelled = false;
    const piece = new Uint8Array(40).fill(120);
    const reply = streamed([piece, piece, piece, piece, piece], () => {
      cancelled = true;
    });
    expect(await textWithin(reply, 100)).toBeUndefined();
    expect(cancelled).toBe(true);
    // The third piece took it over 100 bytes. The fourth and fifth were never asked for.
    expect(sent).toBeLessThanOrEqual(4);
  });

  it("reads an empty reply as empty text", async () => {
    expect(await textWithin(new Response(null), 100)).toBe("");
  });
});

describe("F10: the data class the reviewer's material is given", () => {
  it("is at least what the run was allowed to handle, even when no tool was called", async () => {
    const seen: ReviewInput[] = [];
    const executor: Executor = { name: "scripted", execute: async () => ({ status: "completed", result: 5, logs: [], truncated: false }) };
    const host: RunHost = { callTool: async () => 1, search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }) };
    const output = await runCodeTool(
      { script: "return 5;", project: "demo", criteria: ["The result is the number 5."] },
      {
        executor,
        audit: auditLog(memoryAuditStore(), () => 0),
        hostFor: () => host,
        exposure: async () => ({ allowed: "confidential", provider: "unknown" }),
        allowedDataClass: () => "confidential",
        review: async (input) => {
          seen.push(input);
          return { outcome: "passed" };
        },
        newRunId: () => "run-1",
        now: () => 0,
      },
    );
    expect(output).toMatchObject({ status: "completed" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.dataClass).toBe("confidential");
  });
});
