import { describe, expect, it } from "vitest";
import { runAppTask } from "../src/app/agent";
import { auditLog, memoryAuditStore, verifyChain } from "../src/audit/log";
import { memoryProjectStore } from "../src/broker/exposure";
import { memoryPolicyStore } from "../src/broker/policy-store";
import { memoryQuotaStore } from "../src/broker/quotas";
import { attemptGate } from "../src/code-tool/attempts";
import { sideEffectsMade } from "../src/code-tool/run";
import { ConsoleAccessError, ConsoleChangeError, ownerConsole, requireOwner, TWO_FACTOR_MAX_AGE_MS, type Principal } from "../src/console/console";
import { appMode, INITIAL_CONTROL_STATE, memoryControlStore, ONBOARDING_DEFAULTS, runGate, type ControlState, type ControlStore } from "../src/console/control";
import type { ModelProvider, ToolBackend } from "../src/eval/types";
import type { Executor } from "../src/executor";
import { memoryMeterSink, meter } from "../src/meter/meter";
import { codeToolService } from "../src/service";
import { record } from "./fixtures/policy";

const NOW = 1_800_000_000_000;
const OWNER: Principal = { kind: "owner", id: "owner", twoFactorAt: NOW - 60_000 };

function setup(initial: ControlState = INITIAL_CONTROL_STATE) {
  const control = memoryControlStore(initial);
  const store = memoryAuditStore();
  const console_ = ownerConsole({ control, audit: auditLog(store, () => NOW), now: () => NOW });
  const logged = (): Record<string, unknown>[] => store.entries.map((entry) => ({ kind: entry.kind, ...(JSON.parse(entry.content ?? "{}") as Record<string, unknown>) }));
  return { control, console: console_, store, logged };
}

/** A console that has been through onboarding, with Code Mode on. */
async function running() {
  const made = setup();
  await made.console.completeOnboarding(OWNER, { profile: "lightweight" });
  await made.console.setCodeMode(OWNER, true);
  return made;
}

describe("who may use the owner console (FR-49)", () => {
  it.each<[string, Principal, string]>([
    ["no sign-in", { kind: "anonymous" }, "sign in to use the owner console"],
    ["a model's credential", { kind: "model_client", id: "claude-code" }, "a model's credential cannot be used in the owner console"],
    ["the owner without two-factor sign-in", { kind: "owner", id: "owner", twoFactorAt: undefined }, "two-factor sign-in is required"],
    ["a two-factor sign-in that has expired", { kind: "owner", id: "owner", twoFactorAt: NOW - TWO_FACTOR_MAX_AGE_MS - 1 }, "two-factor sign-in has expired; sign in again"],
    ["a two-factor time in the future", { kind: "owner", id: "owner", twoFactorAt: NOW + 1 }, "two-factor sign-in has expired; sign in again"],
    ["a two-factor time that is not a number", { kind: "owner", id: "owner", twoFactorAt: Number.NaN }, "two-factor sign-in has expired; sign in again"],
  ])("refuses %s, for every action, and changes nothing", async (_label, principal, message) => {
    const { console: c, control, store } = setup();
    const actions = [
      () => c.state(principal),
      () => c.completeOnboarding(principal, { profile: "lightweight" }),
      () => c.setCodeMode(principal, true),
      () => c.kill(principal, "x"),
      () => c.clearKill(principal, "x"),
      () => c.pauseProject(principal, "work", "x"),
      () => c.resumeProject(principal, "work", "x"),
      () => c.blockTool(principal, "github_list_issues", "x"),
      () => c.unblockTool(principal, "github_list_issues", "x"),
    ];
    for (const action of actions) {
      const failure = await action().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConsoleAccessError);
      expect((failure as Error).message).toBe(message);
    }
    expect(control.current()).toEqual(INITIAL_CONTROL_STATE);
    expect(store.entries).toEqual([]);
  });

  it("accepts the owner with two-factor sign-in at the edge of its lifetime", () => {
    expect(() => requireOwner({ kind: "owner", id: "owner", twoFactorAt: NOW - TWO_FACTOR_MAX_AGE_MS }, NOW)).not.toThrow();
    expect(() => requireOwner({ kind: "owner", id: "owner", twoFactorAt: NOW }, NOW)).not.toThrow();
  });
});

describe("onboarding (FR-52)", () => {
  it("starts with everything in its safe position", () => {
    expect(INITIAL_CONTROL_STATE).toEqual({ codeMode: false, killed: false, pausedProjects: [], blockedTools: [], version: 0 });
    expect(ONBOARDING_DEFAULTS).toEqual({ approvers: [], approvedProviders: [], projectDataClasses: {}, meterLevel: "off", outboundAllowlist: [] });
  });

  it("keeps Code Mode off until onboarding is complete", async () => {
    const { console: c, control } = setup();
    await expect(c.setCodeMode(OWNER, true)).rejects.toThrow("Code Mode stays off until onboarding is complete");
    expect(control.current().codeMode).toBe(false);
    await c.completeOnboarding(OWNER, { profile: "formal" });
    // Onboarding records settings; it does not switch anything on.
    expect(control.current().codeMode).toBe(false);
    await c.setCodeMode(OWNER, true);
    expect(control.current().codeMode).toBe(true);
  });

  it("records the governance profile, with every other field at its safe default", async () => {
    const { console: c } = setup();
    const state = await c.completeOnboarding(OWNER, { profile: "lightweight" });
    expect(state.onboarding).toEqual({ profile: "lightweight", approvers: ["owner"], approvedProviders: [], projectDataClasses: {}, meterLevel: "off", outboundAllowlist: [], completedAt: NOW });
  });

  it("will not guess the governance profile", async () => {
    const { console: c } = setup();
    await expect(c.completeOnboarding(OWNER, {} as { profile: "formal" })).rejects.toThrow("choose a governance profile");
    await expect(c.completeOnboarding(OWNER, { profile: "relaxed" as "formal" })).rejects.toThrow(ConsoleChangeError);
  });

  it("records what the owner chose", async () => {
    const { console: c } = setup();
    const state = await c.completeOnboarding(OWNER, { profile: "formal", approvers: ["deputy"], approvedProviders: ["anthropic_api_commercial"], projectDataClasses: { work: "internal" }, meterLevel: "summary", outboundAllowlist: ["https://api.github.com"] });
    expect(state.onboarding).toMatchObject({ profile: "formal", approvers: ["owner", "deputy"], approvedProviders: ["anthropic_api_commercial"], projectDataClasses: { work: "internal" }, meterLevel: "summary", outboundAllowlist: ["https://api.github.com"] });
  });
});

describe("every change is versioned and logged (FR-49)", () => {
  it("gives each change the next version and writes it to the audit log with before and after", async () => {
    const { console: c, logged, store } = setup();
    await c.completeOnboarding(OWNER, { profile: "lightweight" });
    await c.setCodeMode(OWNER, true);
    await c.pauseProject(OWNER, "work", "checking a denial");
    const state = await c.kill(OWNER, "something looks wrong");
    expect(state.version).toBe(4);
    expect(logged().map((entry) => [entry.kind, entry.action, entry.version, entry.by])).toEqual([
      ["console_change", "complete_onboarding", 1, "owner"],
      ["console_change", "code_mode_on", 2, "owner"],
      ["console_change", "pause_project", 3, "owner"],
      ["console_change", "kill", 4, "owner"],
    ]);
    expect(logged()[1]).toMatchObject({ before: { codeMode: false, version: 1 }, after: { codeMode: true, version: 2 } });
    expect(logged()[2]).toMatchObject({ reason: "checking a denial" });
    expect(store.entries[2]?.project).toBe("work");
    expect(await verifyChain(store.entries)).toEqual({ ok: true, entries: 4 });
  });

  it("makes no new version and no log entry when nothing changes", async () => {
    const { console: c, store } = await running();
    const before = store.entries.length;
    expect((await c.setCodeMode(OWNER, true)).version).toBe(2);
    expect((await c.resumeProject(OWNER, "never-paused", "tidying")).version).toBe(2);
    expect((await c.clearKill(OWNER, "not killed")).version).toBe(2);
    expect(store.entries.length).toBe(before);
  });

  it("asks for a reason for anything that lifts a protection", async () => {
    const { console: c } = await running();
    await c.kill(OWNER, "");
    await expect(c.clearKill(OWNER, "  ")).rejects.toThrow("a reason is required");
    await expect(c.resumeProject(OWNER, "work", "")).rejects.toThrow("a reason is required");
    await expect(c.unblockTool(OWNER, "github_list_issues", "")).rejects.toThrow("a reason is required");
  });

  it("does not let two changes made at once overwrite each other", async () => {
    const inner = memoryControlStore({ ...INITIAL_CONTROL_STATE, onboarding: { profile: "lightweight", ...ONBOARDING_DEFAULTS, completedAt: 0 } });
    // Another writer gets in between this console's read and its write, once.
    let interfere = true;
    const racing: ControlStore = {
      read: () => inner.read(),
      async write(next, expected) {
        if (interfere) {
          interfere = false;
          await inner.write({ ...inner.current(), pausedProjects: ["other"], version: inner.current().version + 1 }, inner.current().version);
        }
        return inner.write(next, expected);
      },
    };
    const c = ownerConsole({ control: racing, audit: auditLog(memoryAuditStore(), () => NOW), now: () => NOW });
    const state = await c.setCodeMode(OWNER, true);
    expect(state).toMatchObject({ codeMode: true, pausedProjects: ["other"], version: 2 });
  });

  it("still throws the kill switch when the audit log is down, and says the log entry is missing", async () => {
    const control = memoryControlStore();
    const down = auditLog({ ...memoryAuditStore(), last: async () => Promise.reject(new Error("db down")) }, () => NOW);
    const c = ownerConsole({ control, audit: down, now: () => NOW });
    await expect(c.kill(OWNER, "emergency")).rejects.toThrow("the change was made (version 1) but could not be written to the audit log");
    expect(control.current().killed).toBe(true);
  });
});

describe("what the switches do to a run (FR-16, FR-17, FR-27)", () => {
  it("lets a run start only when Code Mode is on, nothing is killed and the project is not paused", async () => {
    const base: ControlState = { ...INITIAL_CONTROL_STATE, codeMode: true };
    const gate = (state: ControlState) => runGate(memoryControlStore(state))("work");
    expect(await gate(base)).toBeUndefined();
    expect(await gate(INITIAL_CONTROL_STATE)).toEqual({ code: "code_mode_off", message: "Code Mode is switched off" });
    expect(await gate({ ...base, killed: true })).toEqual({ code: "code_mode_off", message: "ExecWard was stopped by the owner with the kill switch" });
    expect(await gate({ ...base, pausedProjects: ["work"] })).toEqual({ code: "code_mode_off", message: "this project is paused until a security exception is reviewed" });
    expect(await gate({ ...base, pausedProjects: ["other"] })).toBeUndefined();
    const broken: ControlStore = { read: async () => Promise.reject(new Error("db down")), write: async () => false };
    expect(await runGate(broken)("work")).toEqual({ code: "code_mode_off", message: "the control state is unavailable, so nothing is run" });
  });

  it("tells the test app what to offer", async () => {
    const base: ControlState = { ...INITIAL_CONTROL_STATE, codeMode: true };
    expect(await appMode(memoryControlStore(base), "work")).toBe("on");
    expect(await appMode(memoryControlStore(INITIAL_CONTROL_STATE), "work")).toBe("off");
    expect(await appMode(memoryControlStore({ ...base, killed: true }), "work")).toBe("stopped");
    expect(await appMode(memoryControlStore({ ...base, pausedProjects: ["work"] }), "work")).toBe("stopped");
  });

  /** The whole service over a console the test drives. The stand-in script calls the tools given, in order. */
  async function service(duringRun?: (step: number) => Promise<void>) {
    const made = await running();
    const upstreamCalls: string[] = [];
    let run = 0;
    const executor: Executor = {
      name: "scripted",
      async execute(request) {
        const seen: unknown[] = [];
        for (const [step, tool] of ["github_list_issues", "github_get_commit", "github_list_issues"].entries()) {
          await duringRun?.(step);
          seen.push(await request.host.callTool(tool, {}).catch((error: Error) => `caught: ${error.message}`));
        }
        return { status: "completed", result: seen, logs: [], truncated: false };
      },
    };
    const serve = codeToolService({
      executor,
      policy: memoryPolicyStore([record("list_issues", { dataClass: "public" }), record("get_commit", { dataClass: "public" })]),
      projects: memoryProjectStore([{ project: "work", dataClass: "internal" }]),
      quotas: memoryQuotaStore(),
      audit: made.store,
      upstream: async ({ record: called }) => (upstreamCalls.push(called.tool), "data"),
      definitionFor: async () => ({ description: "t", inputSchema: { type: "object", additionalProperties: true } }),
      docsFor: async () => undefined,
      meter: meter({ level: "off", sink: memoryMeterSink() }),
      control: made.control,
      now: () => NOW,
      newRunId: () => `run-${++run}`,
    });
    const attempt = () => serve({ script: "return 1;", project: "work" }, { providerRoute: "unknown", attempts: attemptGate() });
    return { ...made, attempt, upstreamCalls };
  }

  it("refuses a run when Code Mode is off, and logs the refusal", async () => {
    const { attempt, console: c, upstreamCalls, logged } = await service();
    expect((await attempt()).status).toBe("completed");
    await c.setCodeMode(OWNER, false);
    expect(await attempt()).toMatchObject({ status: "refused", error: { code: "code_mode_off", message: "Code Mode is switched off" } });
    expect(upstreamCalls.length).toBe(3);
    expect(logged().at(-1)).toMatchObject({ kind: "run_refused", error: { code: "code_mode_off" } });
  });

  it("ends a run at its next call when Code Mode is switched off mid-run, and nothing carries on", async () => {
    const made = await service(async (step) => {
      if (step === 1) await made.console.setCodeMode(OWNER, false);
    });
    const reply = await made.attempt();
    expect(reply).toEqual({
      status: "error",
      error: { code: "code_mode_off", message: "a call was refused: Code Mode is switched off. No side-effecting calls had been made." },
      report: reply.report,
    });
    // One call went out before the switch; the two after it did not.
    expect(made.upstreamCalls).toEqual(["list_issues"]);
    expect(reply.report.callsByTool).toEqual({ github_list_issues: 2, github_get_commit: 1 });
    // The script caught the refusal and returned a value; the value is not handed over.
    expect(JSON.stringify(reply)).not.toContain("caught");
  });

  it("lists side-effecting calls already made, when there are any", () => {
    expect(sideEffectsMade([])).toBe("No side-effecting calls had been made.");
    expect(sideEffectsMade([{ tool: "github_create_issue", summary: "created issue 12" }, { tool: "github_add_label", summary: "added bug" }])).toBe(
      "Side-effecting calls already made: github_create_issue (created issue 12); github_add_label (added bug).",
    );
  });

  it("stops everything with the kill switch, mid-run and after, with no model anywhere in the path", async () => {
    let thrown = false;
    const made = await service(async (step) => {
      if (step === 2 && !thrown) {
        thrown = true;
        await made.console.kill(OWNER, "something looks wrong");
      }
    });
    const reply = await made.attempt();
    expect(reply).toMatchObject({ status: "error", error: { code: "code_mode_off", message: expect.stringContaining("stopped by the owner with the kill switch") as string } });
    expect(made.upstreamCalls).toEqual(["list_issues", "get_commit"]);
    expect(await made.attempt()).toMatchObject({ status: "refused", error: { code: "code_mode_off" } });
    // Code Mode itself was never switched off: the kill switch overrides it.
    expect(made.control.current()).toMatchObject({ codeMode: true, killed: true });
    await made.console.clearKill(OWNER, "reviewed; a false alarm");
    expect((await made.attempt()).status).toBe("completed");
  });

  it("pauses one project and leaves the others running", async () => {
    const { attempt, console: c } = await service();
    await c.pauseProject(OWNER, "other", "a denial there");
    expect((await attempt()).status).toBe("completed");
    await c.pauseProject(OWNER, "work", "a denial here");
    expect(await attempt()).toMatchObject({ status: "refused", error: { code: "code_mode_off", message: "this project is paused until a security exception is reviewed" } });
    await c.resumeProject(OWNER, "work", "reviewed");
    expect((await attempt()).status).toBe("completed");
  });

  it("blocks one tool and ends a run that calls it", async () => {
    const { attempt, console: c, upstreamCalls } = await service();
    await c.blockTool(OWNER, "github_get_commit", "its definition changed");
    expect(await attempt()).toMatchObject({ status: "error", error: { code: "policy_denied", message: "a call was refused: the tool is blocked until its changed definition is reviewed" } });
    expect(upstreamCalls).toEqual(["list_issues"]);
  });

  it("stops the test app asking the model for another turn once the kill switch is set", async () => {
    const control = memoryControlStore({ ...INITIAL_CONTROL_STATE, codeMode: true, killed: true });
    let asked = 0;
    const model: ModelProvider = { provider: "scripted", model: "stand-in", turn: async () => (asked++, { text: "hi", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }) };
    const direct: ToolBackend = { definitions: [], call: async () => null };
    const result = await runAppTask("anything", { model, direct, codeTool: async () => Promise.reject(new Error("not reached")), codeMode: () => appMode(control, "work"), project: "work", providerRoute: "unknown" });
    expect(result).toMatchObject({ stopped: "stopped", answer: "", turns: 0 });
    expect(asked).toBe(0);
  });
});
