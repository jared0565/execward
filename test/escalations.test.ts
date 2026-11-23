import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { attemptGate } from "../src/code-tool/attempts";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import { ConsoleAccessError, type Principal } from "../src/console/console";
import { INITIAL_CONTROL_STATE, memoryControlStore, runGate } from "../src/console/control";
import { APPROVAL_VALID_MS, ESCALATION_MENU, escalationHook, escalationQueue, memoryEscalationStore, PROPOSAL_AFTER_CHOICES, triggerFor, type EscalationItem, type Trigger } from "../src/console/escalations";
import { DIGEST_SUBJECT, digestEmail, notifier, URGENT_SUBJECT, urgentEmail, type Email } from "../src/console/notify";
import type { RunReport } from "../src/contracts/code-tool";
import type { Executor } from "../src/executor";

const HOUR = 3_600_000;
const START = 1_800_000_000_000;
const OWNER = (at: number): Principal => ({ kind: "owner", id: "owner", twoFactorAt: at - 60_000 });

const REPORT: RunReport = {
  runId: "run-7",
  scriptHash: "0".repeat(64),
  callsByTool: { github_get_file: 1 },
  recordsRead: 0,
  recordsWritten: 0,
  errors: [{ code: "policy_denied", message: "a call was refused: the tool has no policy record" }],
  retries: 0,
  assertions: { passed: 0, failed: 0 },
  sideEffects: [],
  verification: "not_applicable",
  durationMs: 4,
};

function setup() {
  let now = START;
  let ids = 0;
  const store = memoryEscalationStore();
  const control = memoryControlStore({ ...INITIAL_CONTROL_STATE, codeMode: true });
  const auditStore = memoryAuditStore();
  const sent: Email[] = [];
  const notify = notifier({ mailer: { send: async (email) => void sent.push(email) }, baseUrl: "https://console.example.com" });
  const queue = escalationQueue({ store, control, audit: auditLog(auditStore, () => now), now: () => now, newId: () => `item${String(++ids).padStart(4, "0")}aBcDeFgHiJkLmN`, onRaised: (item) => notify.raised(item) });
  const logged = (): Record<string, unknown>[] => auditStore.entries.map((entry) => ({ kind: entry.kind, ...(JSON.parse(entry.content ?? "{}") as Record<string, unknown>) }));
  return { queue, store, control, sent, notify, logged, owner: () => OWNER(now), advance: (ms: number) => (now += ms), time: () => now };
}

describe("the options menu (FR-46)", () => {
  const triggers = Object.keys(ESCALATION_MENU) as Trigger[];

  it("offers at most four options per trigger, each saying what it does and whether it can be undone", () => {
    expect(triggers.sort()).toEqual(["cross_check_disagreement", "definition_changed", "repeated_failure", "security_exception", "tier2_action", "unusual_values"]);
    for (const trigger of triggers) {
      const { options } = ESCALATION_MENU[trigger];
      expect(options.length, trigger).toBeGreaterThanOrEqual(3);
      expect(options.length, trigger).toBeLessThanOrEqual(4);
      for (const option of options) {
        expect(option.effect.length, `${trigger}/${option.id}`).toBeGreaterThan(0);
        expect(typeof option.reversible).toBe("boolean");
      }
      expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
    }
  });

  it("puts the safest option first", () => {
    expect(triggers.map((trigger) => [trigger, ESCALATION_MENU[trigger].options[0]?.id]).sort()).toEqual([
      ["cross_check_disagreement", "discard_both"],
      ["definition_changed", "block"],
      ["repeated_failure", "stop"],
      ["security_exception", "keep_paused"],
      ["tier2_action", "reject"],
      ["unusual_values", "reject_result"],
    ]);
  });

  it("recommends by the rules in the PRD's table, and shows the rule", () => {
    const pick = (trigger: Trigger, context = {}) => ESCALATION_MENU[trigger].recommend(context).optionId;
    expect(pick("security_exception")).toBe("keep_paused");
    expect(pick("security_exception", { everyCheckPassed: true, wordingOnlyAndScanClean: true })).toBe("keep_paused");
    expect(pick("definition_changed")).toBe("block");
    expect(pick("definition_changed", { wordingOnlyAndScanClean: true })).toBe("approve_new");
    expect(pick("tier2_action")).toBe("save_draft");
    expect(pick("tier2_action", { everyCheckPassed: true })).toBe("save_draft");
    expect(pick("tier2_action", { everyCheckPassed: true, destinationKnown: true })).toBe("approve_as_shown");
    expect(pick("cross_check_disagreement")).toBe("rerun_stricter");
    expect(pick("cross_check_disagreement", { deterministicResultExists: true })).toBe("use_deterministic");
    expect(pick("repeated_failure")).toBe("stop");
    expect(pick("repeated_failure", { taskType: "exploratory" })).toBe("direct_calls");
    expect(pick("repeated_failure", { taskType: "bounded_tool_heavy" })).toBe("other_model");
    expect(pick("unusual_values")).toBe("rerun_cross_check");
    for (const trigger of triggers) {
      const recommended = ESCALATION_MENU[trigger].recommend({});
      expect(recommended.rule.length, trigger).toBeGreaterThan(10);
      expect(ESCALATION_MENU[trigger].options.some((option) => option.id === recommended.optionId), trigger).toBe(true);
    }
  });

  it("never recommends a false positive, and never lets one through without a reason", () => {
    const falsePositive = ESCALATION_MENU.security_exception.options.find((option) => option.id === "false_positive");
    expect(falsePositive?.needsReason).toBe(true);
  });

  it("uses the PRD's time limits", () => {
    expect(triggers.map((trigger) => [trigger, ESCALATION_MENU[trigger].expiresAfterMs]).sort()).toEqual([
      ["cross_check_disagreement", 24 * HOUR],
      ["definition_changed", null],
      ["repeated_failure", 4 * HOUR],
      ["security_exception", null],
      ["tier2_action", 24 * HOUR],
      ["unusual_values", 24 * HOUR],
    ]);
    expect(APPROVAL_VALID_MS).toBe(15 * 60 * 1000);
  });
});

describe("the escalation queue (FR-44)", () => {
  it("pauses the project at once on a security exception, and queues it with the run report and options", async () => {
    const { queue, control, logged, owner } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-7", error: REPORT.errors[0]!, report: REPORT });
    expect(control.current().pausedProjects).toEqual(["work"]);
    expect(await runGate(control)("work")).toMatchObject({ code: "code_mode_off" });
    expect(await runGate(control)("other")).toBeUndefined();
    expect(item).toMatchObject({ trigger: "security_exception", project: "work", status: "open", urgent: true, report: REPORT, safeAction: "Project paused at once", expiresAt: null, recommended: { optionId: "keep_paused" } });
    expect(item.options.map((option) => option.id)).toEqual(["keep_paused", "block_tool", "revoke_then_resume", "false_positive"]);
    expect(await queue.list(owner())).toEqual([item]);
    expect(logged().map((entry) => [entry.kind, entry.action ?? entry.trigger])).toEqual([
      ["console_change", "pause_project"],
      ["escalation_raised", "security_exception"],
    ]);
  });

  it("does not queue the same run twice", async () => {
    const { queue, store } = setup();
    const first = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-7" });
    const again = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-7" });
    expect(again.id).toBe(first.id);
    expect(store.items.size).toBe(1);
  });

  it("lists urgent items first, then oldest first, and only to the owner", async () => {
    const { queue, owner, advance } = setup();
    const failure = await queue.raise({ trigger: "repeated_failure", project: "work", runId: "run-1" });
    advance(1_000);
    const changed = await queue.raise({ trigger: "definition_changed", project: "work", runId: "run-2" });
    advance(1_000);
    const security = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-3" });
    expect((await queue.list(owner())).map((item) => item.id)).toEqual([security.id, failure.id, changed.id]);
    await expect(queue.list({ kind: "model_client", id: "claude-code" })).rejects.toThrow(ConsoleAccessError);
    await expect(queue.resolve({ kind: "anonymous" }, security.id, "false_positive", "x")).rejects.toThrow(ConsoleAccessError);
    await expect(queue.proposals({ kind: "owner", id: "owner", twoFactorAt: undefined })).rejects.toThrow(ConsoleAccessError);
  });

  it("keeps a security exception open and the project paused when the owner chooses to keep it paused", async () => {
    const { queue, control, owner } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-7" });
    const after = await queue.resolve(owner(), item.id, "keep_paused");
    expect(after).toMatchObject({ status: "open", acknowledgedAt: START });
    expect(control.current().pausedProjects).toEqual(["work"]);
  });

  it("resumes the project on a false positive only with a written reason", async () => {
    const { queue, control, owner, logged } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-7" });
    await expect(queue.resolve(owner(), item.id, "false_positive")).rejects.toThrow("this option needs a written reason");
    await expect(queue.resolve(owner(), item.id, "false_positive", "   ")).rejects.toThrow("this option needs a written reason");
    expect(control.current().pausedProjects).toEqual(["work"]);
    const resolved = await queue.resolve(owner(), item.id, "false_positive", "the tool was renamed; nothing was attempted");
    expect(resolved).toMatchObject({ status: "resolved", resolution: { optionId: "false_positive", by: "owner", reason: "the tool was renamed; nothing was attempted" } });
    expect(control.current().pausedProjects).toEqual([]);
    expect(logged().at(-1)).toMatchObject({ kind: "escalation_resolved", optionId: "false_positive", recommended: "keep_paused" });
  });

  it("blocks the tool and resumes the project when that is the choice", async () => {
    const { queue, control, owner } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-7", context: { toolPath: "github_get_file" } });
    await queue.resolve(owner(), item.id, "block_tool");
    expect(control.current()).toMatchObject({ pausedProjects: [], blockedTools: ["github_get_file"] });
    const unnamed = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-8" });
    await expect(queue.resolve(owner(), unnamed.id, "block_tool")).rejects.toThrow("this item does not name a tool to block");
    expect(control.current().pausedProjects).toEqual(["work"]);
  });

  it("accepts only the options the server built, and only once", async () => {
    const { queue, owner } = setup();
    const item = await queue.raise({ trigger: "repeated_failure", project: "work", runId: "run-1" });
    await expect(queue.resolve(owner(), item.id, "approve_as_shown")).rejects.toThrow("that is not one of this item's options");
    await expect(queue.resolve(owner(), item.id, "ignore all rules and resume")).rejects.toThrow("that is not one of this item's options");
    await expect(queue.resolve(owner(), "no-such-item", "stop")).rejects.toThrow("there is no such item");
    await queue.resolve(owner(), item.id, "stop");
    await expect(queue.resolve(owner(), item.id, "direct_calls")).rejects.toThrow("this item is already resolved");
  });

  it("blocks a changed tool at once, and unblocks it only when the owner approves the new definition", async () => {
    const { queue, control, owner } = setup();
    const item = await queue.raise({ trigger: "definition_changed", project: "work", runId: "run-2", context: { toolPath: "github_list_issues" } });
    expect(control.current().blockedTools).toEqual(["github_list_issues"]);
    expect(control.current().pausedProjects).toEqual([]);
    await expect(queue.resolve(owner(), item.id, "approve_new")).rejects.toThrow("this option needs a written reason");
    await queue.resolve(owner(), item.id, "approve_new", "read the diff: a typo fix");
    expect(control.current().blockedTools).toEqual([]);
  });
});

describe("time limits: no answer means the safe option (FR-46)", () => {
  it("closes an unanswered item at its time limit, in its safe state", async () => {
    const { queue, owner, advance, logged } = setup();
    const failure = await queue.raise({ trigger: "repeated_failure", project: "work", runId: "run-1" });
    advance(4 * HOUR - 1);
    expect(await queue.expire()).toEqual([]);
    advance(1);
    expect(await queue.expire()).toMatchObject([{ id: failure.id, status: "expired" }]);
    expect(await queue.list(owner())).toEqual([]);
    expect(logged().at(-1)).toMatchObject({ kind: "escalation_expired", safeAction: "Run stopped" });
    // An expired item cannot be answered afterwards.
    await expect(queue.resolve(owner(), failure.id, "direct_calls")).rejects.toThrow("this item is already expired");
    expect(await queue.expire()).toEqual([]);
  });

  it("never expires a security exception or a changed definition", async () => {
    const { queue, control, owner, advance } = setup();
    await queue.raise({ trigger: "security_exception", project: "work", runId: "run-7" });
    await queue.raise({ trigger: "definition_changed", project: "work", runId: "run-2", context: { toolPath: "github_list_issues" } });
    advance(400 * 24 * HOUR);
    expect(await queue.expire()).toEqual([]);
    expect((await queue.list(owner())).length).toBe(2);
    expect(control.current()).toMatchObject({ pausedProjects: ["work"], blockedTools: ["github_list_issues"] });
  });

  it("never approves anything by expiry", async () => {
    const { queue, advance } = setup();
    await queue.raise({ trigger: "tier2_action", project: "work", runId: "run-9" });
    advance(25 * HOUR);
    const [expired] = await queue.expire();
    expect(expired).toMatchObject({ status: "expired", safeAction: "Action held" });
    expect(expired?.resolution).toBeUndefined();
  });
});

describe("repeated choices are offered as rules, never adopted (FR-46)", () => {
  it("proposes a rule after the same choice is made three times, and changes nothing by doing so", async () => {
    const { queue, control, owner } = setup();
    expect(PROPOSAL_AFTER_CHOICES).toBe(3);
    const before = control.current();
    for (let n = 1; n <= 3; n++) {
      const item = await queue.raise({ trigger: "repeated_failure", project: "work", runId: `run-${n}` });
      await queue.resolve(owner(), item.id, "direct_calls");
      expect((await queue.proposals(owner())).length, `after ${n}`).toBe(n === 3 ? 1 : 0);
    }
    expect(await queue.proposals(owner())).toEqual([
      { trigger: "repeated_failure", optionId: "direct_calls", timesChosen: 3, proposal: 'You chose "Retry with direct calls instead of a script" 3 times. Make it a rule?' },
    ]);
    // Offering is all it does: the next failure is queued and handled exactly as before.
    expect(control.current()).toEqual(before);
    const next = await queue.raise({ trigger: "repeated_failure", project: "work", runId: "run-4" });
    expect(next).toMatchObject({ status: "open", recommended: { optionId: "stop" } });
  });

  it("counts different choices and different tools apart", async () => {
    const { queue, owner } = setup();
    const choices = ["stop", "direct_calls", "stop", "direct_calls"];
    for (const [n, choice] of choices.entries()) {
      const item = await queue.raise({ trigger: "repeated_failure", project: "work", runId: `run-${n}` });
      await queue.resolve(owner(), item.id, choice);
    }
    expect(await queue.proposals(owner())).toEqual([]);
  });

  it("never proposes a rule for security exceptions", async () => {
    const { queue, owner } = setup();
    for (let n = 0; n < 5; n++) {
      const item = await queue.raise({ trigger: "security_exception", project: "work", runId: `run-${n}` });
      await queue.resolve(owner(), item.id, "false_positive", "the same harmless thing");
    }
    expect(await queue.proposals(owner())).toEqual([]);
  });
});

describe("emails carry a link and nothing else (FR-49, flag 11)", () => {
  /** Everything about an item that must never appear in an email. */
  const SECRET_ITEM: EscalationItem = {
    id: "k3Jx9QpLm2Zt7VbN4wRs",
    trigger: "security_exception",
    project: "acme-payroll",
    createdAt: START,
    urgent: true,
    status: "open",
    runId: "run-4417",
    error: { code: "policy_denied", message: "the run has read sensitive data from github_get_file" },
    report: { ...REPORT, callsByTool: { github_get_salary_file: 3 }, recordsRead: 9000 },
    context: { toolPath: "github_get_salary_file" },
    options: ESCALATION_MENU.security_exception.options,
    recommended: ESCALATION_MENU.security_exception.recommend({}),
    safeAction: "Project paused at once",
    expiresAt: null,
  };

  it("builds a body that is fixed text plus one link", () => {
    expect(urgentEmail(SECRET_ITEM, "https://console.example.com")).toEqual({
      subject: URGENT_SUBJECT,
      body: "Something in ExecWard needs your review now. Sign in to see it:\n\nhttps://console.example.com/escalations/k3Jx9QpLm2Zt7VbN4wRs\n",
    });
    expect(digestEmail("https://console.example.com")).toEqual({
      subject: DIGEST_SUBJECT,
      body: "There are items waiting for your review in ExecWard. Sign in to see them:\n\nhttps://console.example.com/escalations\n",
    });
  });

  it("scans each email for data from the item, and finds none", () => {
    const emails = [urgentEmail(SECRET_ITEM, "https://console.example.com"), digestEmail("https://console.example.com")];
    const forbidden = ["acme", "payroll", "run-4417", "policy_denied", "sensitive", "github", "salary", "9000", "security", "paused", "keep_paused", "false positive"];
    for (const email of emails) {
      const text = `${email.subject}\n${email.body}`.toLowerCase();
      for (const word of forbidden) expect(text, word).not.toContain(word);
      // Exactly one link, and no digits outside it.
      expect(email.body.match(/https?:\/\//g)?.length).toBe(1);
      expect(email.body.replace(/https:\/\/\S+/, "")).not.toMatch(/\d/);
    }
  });

  it("refuses to build a link from an ID that could carry data, or to a page that is not https", () => {
    expect(() => urgentEmail({ id: "acme payroll run 4417" }, "https://console.example.com")).toThrow("not safe to put in a link");
    expect(() => urgentEmail({ id: "../../admin?x=1" }, "https://console.example.com")).toThrow("not safe to put in a link");
    expect(() => urgentEmail({ id: "short" }, "https://console.example.com")).toThrow("not safe to put in a link");
    expect(() => urgentEmail(SECRET_ITEM, "http://console.example.com")).toThrow("must use https");
  });

  it("sends an urgent item at once and on its own, and leaves the rest for the digest", async () => {
    const { queue, sent, notify, owner } = setup();
    await queue.raise({ trigger: "repeated_failure", project: "work", runId: "run-1" });
    await queue.raise({ trigger: "definition_changed", project: "work", runId: "run-2" });
    expect(sent).toEqual([]);
    const security = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-3" });
    expect(sent.map((email) => email.subject)).toEqual([URGENT_SUBJECT]);
    expect(sent[0]?.body).toContain(`/escalations/${security.id}`);
    expect(await notify.digest(await queue.list(owner()))).toBe(true);
    expect(sent.map((email) => email.subject)).toEqual([URGENT_SUBJECT, DIGEST_SUBJECT]);
  });

  it("sends no digest when only urgent items are waiting, or nothing is", async () => {
    const { queue, sent, notify, owner } = setup();
    expect(await notify.digest([])).toBe(false);
    await queue.raise({ trigger: "security_exception", project: "work", runId: "run-3" });
    expect(await notify.digest(await queue.list(owner()))).toBe(false);
    expect(sent.length).toBe(1);
  });

  it("reminds hourly about an open security exception until it is reviewed", async () => {
    const { queue, sent, notify, owner, advance, time } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-3" });
    advance(HOUR - 1);
    expect(await notify.remind(await queue.list(owner()), time())).toBe(0);
    advance(1);
    expect(await notify.remind(await queue.list(owner()), time())).toBe(1);
    expect(await notify.remind(await queue.list(owner()), time())).toBe(0);
    advance(HOUR);
    expect(await notify.remind(await queue.list(owner()), time())).toBe(1);
    await queue.resolve(owner(), item.id, "false_positive", "reviewed");
    advance(5 * HOUR);
    expect(await notify.remind(await queue.list(owner()), time())).toBe(0);
    expect(sent.length).toBe(3);
  });

  it("still queues the item when the email cannot be sent", async () => {
    const store = memoryEscalationStore();
    const control = memoryControlStore({ ...INITIAL_CONTROL_STATE, codeMode: true });
    const queue = escalationQueue({ store, control, audit: auditLog(memoryAuditStore(), () => START), now: () => START, newId: () => "k3Jx9QpLm2Zt7VbN4wRs", onRaised: async () => Promise.reject(new Error("mail is down")) });
    const item = await queue.raise({ trigger: "security_exception", project: "work", runId: "run-3" });
    expect(store.items.get(item.id)?.status).toBe("open");
    expect(control.current().pausedProjects).toEqual(["work"]);
  });
});

describe("a closed task reaches the queue (FR-41, FR-44)", () => {
  it("maps each way a task closes to its trigger", () => {
    const of = (reason: "security" | "retries_exhausted" | "not_retryable", code: "policy_denied" | "definition_changed" | "script_error" | "code_mode_off" | "sandbox_fault") =>
      triggerFor({ reason, error: { code, message: "m" }, runId: "r" });
    expect(of("security", "policy_denied")).toBe("security_exception");
    expect(of("security", "definition_changed")).toBe("definition_changed");
    expect(of("retries_exhausted", "script_error")).toBe("repeated_failure");
    expect(of("not_retryable", "sandbox_fault")).toBe("repeated_failure");
    // The owner switched it off; the owner does not need telling.
    expect(of("not_retryable", "code_mode_off")).toBeUndefined();
  });

  it("pauses the project when a run is refused by policy, so the next run does not start", async () => {
    const { queue, control, store, owner } = setup();
    const denied: RunHost = { callTool: async () => 1, search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }), securityError: () => ({ code: "policy_denied", message: "a call was refused: the tool has no policy record" }) };
    const executor: Executor = { name: "scripted", execute: async () => ({ status: "completed", result: 1, logs: [], truncated: false }) };
    let run = 0;
    const attempt = () =>
      runCodeTool({ script: "return 1;", project: "work" }, { executor, audit: auditLog(memoryAuditStore(), () => START), hostFor: () => denied, newRunId: () => `run-${++run}`, now: () => START, control: runGate(control), attempts: attemptGate({ onEscalate: escalationHook(queue, "work") }) });

    expect(await attempt()).toMatchObject({ status: "error", error: { code: "policy_denied" } });
    // The pause has landed by the time the reply is handed over.
    expect(control.current().pausedProjects).toEqual(["work"]);
    expect([...store.items.values()]).toMatchObject([{ trigger: "security_exception", runId: "run-1", error: { code: "policy_denied" } }]);

    // A fresh task in the same project is refused before it starts.
    const next = await runCodeTool({ script: "return 1;", project: "work" }, { executor, audit: auditLog(memoryAuditStore(), () => START), hostFor: () => denied, newRunId: () => "run-9", now: () => START, control: runGate(control), attempts: attemptGate({ onEscalate: escalationHook(queue, "work") }) });
    expect(next).toMatchObject({ status: "refused", error: { code: "code_mode_off", message: "this project is paused until a security exception is reviewed" } });
    // Being refused for the pause does not raise a second item.
    expect((await queue.list(owner())).length).toBe(1);
  });
});
