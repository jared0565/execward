import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { memoryQuotaStore, type QuotaStore } from "../src/broker/quotas";
import { memoryControlStore } from "../src/console/control";
import { ESCALATION_MENU, escalationQueue, memoryEscalationStore } from "../src/console/escalations";
import { runMaintenance } from "../src/maintenance";
import { FAILED_DAYS_BEFORE_OFF, GOLDEN_REVIEW_CASES, quotaGoldenStore, reviewerIsOff, runGoldenCheck } from "../src/verify/golden";
import { productionReviewer } from "../src/verify/production";
import type { Reviewer, ReviewInput, ReviewVerdict } from "../src/verify/reviewer";

const DAY = 24 * 60 * 60_000;
const START = 20_000 * DAY + 3_600_000;

/** A reviewer that gives each case the verdict the test names, by the case's output. */
function scripted(verdictFor: (input: ReviewInput) => ReviewVerdict): Reviewer & { readonly asked: ReviewInput[] } {
  const asked: ReviewInput[] = [];
  return {
    asked,
    async review(input) {
      asked.push(input);
      return verdictFor(input);
    },
  };
}

/** The right verdict for every golden case. */
const right = (input: ReviewInput): ReviewVerdict => {
  const golden = GOLDEN_REVIEW_CASES.find((candidate) => JSON.stringify(candidate.output) === JSON.stringify(input.output) && candidate.intent === input.intent);
  if (!golden) throw new Error("not a golden case");
  return golden.expect === "passed" ? { outcome: "passed" } : { outcome: "blocked", unmet: [1] };
};
/** A model that passes everything, as one persuaded by planted text would. */
const passesEverything = (): ReviewVerdict => ({ outcome: "passed" });

function setup(quotas: QuotaStore = memoryQuotaStore()) {
  let now = START;
  const audit = memoryAuditStore();
  const escalations = memoryEscalationStore();
  const queue = escalationQueue({ store: escalations, control: memoryControlStore(), audit: auditLog(audit, () => now), now: () => now, newId: () => `esc-${escalations.items.size + 1}` });
  const store = quotaGoldenStore(quotas);
  const check = (reviewer: Reviewer) => runGoldenCheck({ reviewer, store, queue, audit: auditLog(audit, () => now), now: () => now });
  return { check, store, audit, escalations, quotas, now: () => now, nextDay: () => void (now += DAY) };
}

describe("the golden cases for the reviewer (task 2.2.4, FR-45)", () => {
  it("have one right verdict each, cover both verdicts, and include text aimed at the reviewer", () => {
    expect(new Set(GOLDEN_REVIEW_CASES.map((golden) => golden.id)).size).toBe(GOLDEN_REVIEW_CASES.length);
    expect(GOLDEN_REVIEW_CASES.some((golden) => golden.expect === "passed")).toBe(true);
    expect(GOLDEN_REVIEW_CASES.some((golden) => golden.expect === "blocked")).toBe(true);
    expect(GOLDEN_REVIEW_CASES.some((golden) => golden.expect === "blocked" && JSON.stringify(golden.output).includes("REVIEWER:"))).toBe(true);
    for (const golden of GOLDEN_REVIEW_CASES) expect(golden.criteria.length).toBeGreaterThan(0);
  });
});

describe("what the check remembers", () => {
  it("lets exactly one asker a day be first", async () => {
    const store = quotaGoldenStore(memoryQuotaStore());
    expect(await Promise.all([store.claimDay(START), store.claimDay(START), store.claimDay(START + 60_000)])).toEqual([true, false, false]);
    expect(await store.claimDay(START + DAY)).toBe(true);
  });

  it("counts failed days across days, and clears them", async () => {
    const store = quotaGoldenStore(memoryQuotaStore());
    expect(await store.failedDays(START)).toBe(0);
    expect(await store.recordFailedDay(START)).toBe(1);
    expect(await store.recordFailedDay(START + DAY)).toBe(2);
    expect(await store.failedDays(START + 40 * DAY)).toBe(2);
    await store.clearFailedDays(START + 40 * DAY);
    expect(await store.failedDays(START + 41 * DAY)).toBe(0);
  });

  it("treats the reviewer as off when the count cannot be read", async () => {
    expect(
      await reviewerIsOff(
        {
          failedDays: async () => {
            throw new Error("database down");
          },
        },
        START,
      ),
    ).toBe(true);
  });
});

describe("the daily check of the reviewer", () => {
  it("asks every case once, records the day as passed, and leaves the reviewer on", async () => {
    const { check, store, audit, escalations, now } = setup();
    const reviewer = scripted(right);
    expect(await check(reviewer)).toBe(`${GOLDEN_REVIEW_CASES.length} of ${GOLDEN_REVIEW_CASES.length} cases right`);
    expect(reviewer.asked).toHaveLength(GOLDEN_REVIEW_CASES.length);
    expect(reviewer.asked.every((input) => input.project === "system" && input.dataClass === "public" && input.tier === 0 && input.deterministicCheckPassed)).toBe(true);
    expect(await reviewerIsOff(store, now())).toBe(false);
    expect(escalations.items.size).toBe(0);
    const entry = audit.entries.find((candidate) => candidate.kind === "reviewer_check");
    expect(JSON.stringify(entry).replaceAll(String.fromCharCode(92), "")).toContain('"result":"passed"');
  });

  it("runs at most once a day, however often the timer asks", async () => {
    const { check } = setup();
    const reviewer = scripted(right);
    await check(reviewer);
    expect(await check(reviewer)).toBe("already run today");
    expect(reviewer.asked).toHaveLength(GOLDEN_REVIEW_CASES.length);
  });

  it("counts one failed day without switching the reviewer off or raising anything", async () => {
    const { check, store, escalations, now } = setup();
    const said = await check(scripted(passesEverything));
    expect(said).toContain("cases wrong; failed days in a row: 1");
    expect(said).not.toContain("the reviewer is off");
    expect(await reviewerIsOff(store, now())).toBe(false);
    expect(escalations.items.size).toBe(0);
  });

  it("switches the reviewer off after two failed days in a row, and tells the owner once", async () => {
    const { check, store, escalations, nextDay, now } = setup();
    await check(scripted(passesEverything));
    nextDay();
    expect(await check(scripted(passesEverything))).toContain("failed days in a row: 2; the reviewer is off");
    expect(FAILED_DAYS_BEFORE_OFF).toBe(2);
    expect(await reviewerIsOff(store, now())).toBe(true);
    const items = [...escalations.items.values()];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ trigger: "reviewer_check_failed", project: "system", status: "open", urgent: false, safeAction: "Reviewer switched off" });
    expect(items[0]?.options.map((option) => option.id)).toEqual(["leave_off", "other_model", "back_on_now"]);
    expect(items[0]?.recommended.optionId).toBe("leave_off");
  });

  it("goes on checking while the reviewer is off, and the first day that passes switches it back on", async () => {
    const { check, store, nextDay, now } = setup();
    await check(scripted(passesEverything));
    nextDay();
    await check(scripted(passesEverything));
    nextDay();
    const recovered = scripted(right);
    expect(await check(recovered)).toContain("cases right");
    expect(recovered.asked).toHaveLength(GOLDEN_REVIEW_CASES.length);
    expect(await reviewerIsOff(store, now())).toBe(false);
  });

  it("does not let a passing day between two failed ones add up to two in a row", async () => {
    const { check, store, nextDay, now } = setup();
    await check(scripted(passesEverything));
    nextDay();
    await check(scripted(right));
    nextDay();
    await check(scripted(passesEverything));
    expect(await store.failedDays(now())).toBe(1);
    expect(await reviewerIsOff(store, now())).toBe(false);
  });

  it("counts an answer that is not a verdict as wrong", async () => {
    const { check } = setup();
    expect(await check(scripted(() => ({ outcome: "unreviewed", reason: "unreadable_verdict" })))).toContain(`${GOLDEN_REVIEW_CASES.length} of ${GOLDEN_REVIEW_CASES.length} cases wrong`);
  });

  it.each([
    ["there is no key", { outcome: "unreviewed", reason: "reviewer_refused", detail: "no_credential" } as ReviewVerdict],
    ["the budget is spent", { outcome: "unreviewed", reason: "reviewer_refused", detail: "budget_exceeded" } as ReviewVerdict],
    ["the provider is down", { outcome: "unreviewed", reason: "reviewer_failed" } as ReviewVerdict],
  ])("counts nothing, for or against the model, when %s", async (_label, verdict) => {
    const { check, store, audit, nextDay, now } = setup();
    await check(scripted(passesEverything));
    nextDay();
    expect(await check(scripted(() => verdict))).toContain("could not be asked");
    // The earlier failed day still stands, and no second one was added.
    expect(await store.failedDays(now())).toBe(1);
    expect(JSON.stringify(audit.entries.at(-1)).replaceAll(String.fromCharCode(92), "")).toContain('"result":"not_asked"');
  });
});

describe("the reviewer as production builds it", () => {
  const reply = () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"verdict":"pass","unmet":[]}' }] }], usage: { input_tokens: 400, output_tokens: 30 } });
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

  function build() {
    const sent: string[] = [];
    const quotas = memoryQuotaStore();
    const inner = (async (url: string | URL | Request) => {
      sent.push(String(url));
      return reply();
    }) as typeof fetch;
    const reviewing = productionReviewer({ key: () => "fake-verification-key-000", quotas, now: () => START, sink: { write: async () => undefined }, fetch: inner });
    return { reviewing, sent };
  }

  it("reviews runs while the check has it on", async () => {
    const { reviewing, sent } = build();
    expect((await reviewing.forRuns.review(INPUT)).outcome).toBe("passed");
    expect(sent).toEqual(["https://api.openai.com/v1/responses"]);
  });

  it("gives runs no verdict, and sends nothing, while the check has it off; the check itself still asks", async () => {
    const { reviewing, sent } = build();
    await reviewing.golden.recordFailedDay(START);
    await reviewing.golden.recordFailedDay(START);
    expect(await reviewing.forRuns.review(INPUT)).toEqual({ outcome: "unreviewed", reason: "reviewer_off" });
    expect(sent).toEqual([]);
    expect((await reviewing.forTheCheck.review(INPUT)).outcome).toBe("passed");
    expect(sent).toHaveLength(1);
  });
});

describe("the check in the daily round", () => {
  it("runs before the digest, so an item it raises is in the same day's email, and is not part of the frequent round", async () => {
    const order: string[] = [];
    const deps = {
      audit: memoryAuditStore(),
      queue: { expire: async () => [] },
      escalations: { all: async () => [] },
      notifier: {
        digest: async () => {
          order.push("digest");
          return false;
        },
        remind: async () => 0,
      },
      checkReviewer: async () => {
        order.push("check");
        return "5 of 5 cases right";
      },
      now: () => START,
    };
    const daily = await runMaintenance(deps, "daily");
    expect(order).toEqual(["check", "digest"]);
    expect(daily.find((job) => job.job === "check_reviewer")).toEqual({ job: "check_reviewer", ok: true, detail: "5 of 5 cases right" });
    expect((await runMaintenance(deps, "frequent")).some((job) => job.job === "check_reviewer")).toBe(false);
  });

  it("reports a check that broke without stopping the other jobs", async () => {
    const daily = await runMaintenance(
      {
        audit: memoryAuditStore(),
        queue: { expire: async () => [] },
        escalations: { all: async () => [] },
        checkReviewer: async () => {
          throw new Error("boom");
        },
        sweepCounters: async () => undefined,
        now: () => START,
      },
      "daily",
    );
    expect(daily.find((job) => job.job === "check_reviewer")).toMatchObject({ ok: false });
    expect(daily.find((job) => job.job === "sweep_counters")).toMatchObject({ ok: true });
  });

  it("has a menu entry whose first and recommended option changes nothing, and asks for a reason to switch back on early", () => {
    const spec = ESCALATION_MENU.reviewer_check_failed;
    expect(spec.options[0]?.id).toBe("leave_off");
    expect(spec.recommend({}).optionId).toBe("leave_off");
    expect(spec.options.find((option) => option.id === "back_on_now")?.needsReason).toBe(true);
    expect(spec.urgent).toBe(false);
    expect(spec.expiresAfterMs).toBe(24 * 60 * 60 * 1000);
  });
});
