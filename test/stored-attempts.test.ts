import { describe, expect, it } from "vitest";
import type { Escalation } from "../src/code-tool/attempts";
import { ATTEMPT_IDLE_MS, attemptKey, memoryAttemptStore, storedAttemptGate } from "../src/code-tool/stored-attempts";
import type { CodeToolOutput } from "../src/contracts/code-tool";
import type { ErrorCode } from "../src/contracts/errors";

const START = Date.UTC(2026, 10, 24, 14);
const KEY = attemptKey("owner:1", "acme");

const report = (runId: string): CodeToolOutput["report"] => ({
  runId,
  scriptHash: "a".repeat(64),
  callsByTool: {},
  recordsRead: 0,
  recordsWritten: 0,
  errors: [],
  retries: 0,
  assertions: { passed: 0, failed: 0 },
  sideEffects: [],
  verification: "not_applicable",
  durationMs: 1,
});
const failed = (code: ErrorCode = "script_error", runId = "run"): CodeToolOutput => ({ status: code === "script_error" ? "error" : "refused", error: { code, message: "it failed" }, report: report(runId) }) as CodeToolOutput;
const completed: CodeToolOutput = { status: "completed", result: 1, truncated: false, untrusted: true, report: { ...report("ok"), verification: "unreviewed" } };

function setup() {
  const store = memoryAttemptStore();
  const escalations: Escalation[] = [];
  const open = new Set<string>();
  let clock = START;
  const deps = {
    store,
    now: () => clock,
    escalate: async (escalation: Escalation) => {
      escalations.push(escalation);
      const id = `item-${escalations.length}`;
      open.add(id);
      return id;
    },
    stillOpen: async (id: string) => open.has(id),
  };
  /** One request: a fresh gate, as each MCP request gets, then how the run ended. */
  const attempt = async (output: CodeToolOutput, key = KEY) => {
    const gate = await storedAttemptGate(deps, key);
    const blocked = gate.blocked();
    // What the run is told before it starts.
    const before = { retries: gate.retries(), remaining: gate.remaining() };
    await gate.settle(blocked ? ({ status: "refused", error: blocked, report: report("refused") } as CodeToolOutput) : output);
    return { blocked, ...before };
  };
  return { store, escalations, open, attempt, deps, advance: (ms: number) => void (clock += ms) };
}

describe("the retry limit kept between requests (task 2.1.5, FR-41)", () => {
  it("lets two retries follow a failure and refuses the run after the third failure, across separate requests", async () => {
    const { attempt, escalations } = setup();
    expect((await attempt(failed())).blocked).toBeUndefined();
    expect((await attempt(failed())).blocked).toBeUndefined();
    // The third failure in a row: this run was allowed to start, and its failure closes the project.
    const third = await attempt(failed("script_error", "run-3"));
    expect(third.blocked).toBeUndefined();
    expect(escalations).toEqual([{ reason: "retries_exhausted", error: { code: "script_error", message: "it failed" }, runId: "run-3" }]);
    // The next request is refused before it runs.
    const fourth = await attempt(completed);
    expect(fourth.blocked?.code).toBe("quota_exceeded");
    expect(fourth.remaining).toBe(0);
    expect(escalations).toHaveLength(1);
  });

  it("tells each new request how many failures came before it", async () => {
    const { attempt } = setup();
    await attempt(failed());
    await attempt(failed());
    const gate = await attempt(completed);
    expect(gate.retries).toBe(2);
  });

  it("clears the count on a run that completes", async () => {
    const { attempt, store } = setup();
    await attempt(failed());
    await attempt(failed());
    await attempt(completed);
    expect(store.states.size).toBe(0);
    await attempt(failed());
    await attempt(failed());
    expect((await attempt(completed)).blocked).toBeUndefined();
  });

  it("closes at once on a security failure, and tells the owner once", async () => {
    const { attempt, escalations } = setup();
    await attempt(failed("policy_denied", "run-1"));
    expect(escalations.map((escalation) => escalation.reason)).toEqual(["security"]);
    const next = await attempt(completed);
    expect(next.blocked?.code).toBe("policy_denied");
    expect(escalations).toHaveLength(1);
  });

  it("does not count a refusal by a switch the owner threw", async () => {
    const { attempt, store } = setup();
    for (let index = 0; index < 5; index++) expect((await attempt(failed("code_mode_off"))).blocked).toBeUndefined();
    expect(store.states.size).toBe(0);
  });

  it("keeps each caller and each project apart", async () => {
    const { attempt } = setup();
    for (let index = 0; index < 3; index++) await attempt(failed());
    expect((await attempt(completed)).blocked).toBeDefined();
    expect((await attempt(completed, attemptKey("owner:1", "other-project"))).blocked).toBeUndefined();
    expect((await attempt(completed, attemptKey("owner:2", "acme"))).blocked).toBeUndefined();
    // A name cannot be written so as to land on another caller's count.
    expect(attemptKey("owner:1\nacme", "x")).not.toBe(attemptKey("owner:1", "acme\nx"));
  });

  it("reopens when the owner has dealt with the queue item", async () => {
    const { attempt, open } = setup();
    for (let index = 0; index < 3; index++) await attempt(failed());
    expect((await attempt(completed)).blocked).toBeDefined();
    open.clear();
    const after = await attempt(completed);
    expect(after.blocked).toBeUndefined();
    expect(after.retries).toBe(0);
  });

  it("reopens after thirty minutes with no attempt, and not before", async () => {
    const { attempt, advance } = setup();
    for (let index = 0; index < 3; index++) await attempt(failed());
    advance(ATTEMPT_IDLE_MS - 1);
    expect((await attempt(completed)).blocked).toBeDefined();
    // That attempt started the wait again.
    advance(ATTEMPT_IDLE_MS - 1);
    expect((await attempt(completed)).blocked).toBeDefined();
    advance(ATTEMPT_IDLE_MS + 1);
    expect((await attempt(completed)).blocked).toBeUndefined();
  });

  it("forgets failures older than thirty minutes", async () => {
    const { attempt, advance } = setup();
    await attempt(failed());
    await attempt(failed());
    advance(ATTEMPT_IDLE_MS + 1);
    expect((await attempt(failed())).retries).toBe(0);
    expect((await attempt(failed())).blocked).toBeUndefined();
  });

  it("counts every one of several runs that fail at the same moment", async () => {
    const { deps, store, escalations } = setup();
    const gates = await Promise.all([1, 2, 3, 4].map(() => storedAttemptGate(deps, KEY)));
    await Promise.all(gates.map((gate, index) => gate.settle(failed("script_error", `run-${index}`))));
    expect(store.states.get(KEY)?.failures).toBe(4);
    expect(store.states.get(KEY)?.closed?.code).toBe("quota_exceeded");
    // Exactly one of them tells the owner. On production on 2026-11-24 two did.
    expect(escalations).toHaveLength(1);
    expect(store.states.get(KEY)?.escalationId).toBe("item-1");
    expect((await storedAttemptGate(deps, KEY)).blocked()).toBeDefined();
  });

  it("is found closed by a run that starts while the owner is still being told", async () => {
    // What happened on production on 2026-11-24: the closure was written only after the queue item was raised,
    // and a run that started in between was let through.
    const { deps, store } = setup();
    store.states.set(KEY, { failures: 2, updatedAt: START });
    let duringTelling: Promise<boolean> | undefined;
    const gate = await storedAttemptGate(
      {
        ...deps,
        escalate: async (escalation) => {
          duringTelling = storedAttemptGate(deps, KEY).then((next) => next.blocked() !== undefined);
          await duringTelling;
          return deps.escalate(escalation);
        },
      },
      KEY,
    );
    await gate.settle(failed());
    expect(await duringTelling).toBe(true);
  });

  it("stays closed when the owner could not be told", async () => {
    const { deps, attempt } = setup();
    const gate = await storedAttemptGate(
      {
        ...deps,
        escalate: async () => {
          throw new Error("the queue is down");
        },
      },
      KEY,
    );
    await gate.settle(failed("policy_denied"));
    expect((await attempt(completed)).blocked?.code).toBe("policy_denied");
  });

  it("refuses to give a gate when the count cannot be read", async () => {
    const { deps } = setup();
    const broken = {
      ...deps.store,
      get: async () => {
        throw new Error("the database is down");
      },
    };
    await expect(storedAttemptGate({ ...deps, store: broken }, KEY)).rejects.toThrow();
  });
});
