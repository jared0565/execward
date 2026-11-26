/**
 * Self-correction for callers with no session (task 2.1.5, FR-41).
 *
 * Over MCP each request stands alone, and may be served by a different copy
 * of the Worker, so the count of failed runs cannot live in memory. Here it
 * is kept in a store, per signed-in caller and project (the project owner's
 * decision, 2026-11-24).
 *
 * The rule, in the terms of ./attempts.ts:
 * - A run that completes clears the count.
 * - A run that fails adds one. `maxRetries` failures in a row may be followed
 *   by another try; the failure after that closes the project to this caller
 *   and goes to the owner's queue.
 * - A security failure closes it at once.
 * - A refusal by a switch the owner threw is not counted: it is not the
 *   model's failure, and it is not news to the owner.
 *
 * Once closed, it reopens when the owner deals with the queue item, when that
 * item runs out of time, or after `idleMs` with no attempt at all. Every
 * attempt while closed starts that wait again.
 */
import { ERROR_CODES, type ExecWardError } from "../contracts/errors";
import { SELF_CORRECTION } from "../limits";
import type { AttemptGate, Escalation } from "./attempts";

/** With no attempt for this long, what happened before is forgotten. */
export const ATTEMPT_IDLE_MS = 30 * 60 * 1000;

export interface AttemptState {
  readonly failures: number;
  /** The refusal every further run gets. Absent while the caller may still try. */
  readonly closed?: ExecWardError;
  /** The owner's queue item for the closure, when one was raised. */
  readonly escalationId?: string;
  readonly updatedAt: number;
}

export interface AttemptStore {
  get(key: string): Promise<AttemptState | undefined>;
  /**
   * Adds one failure and returns the new count, in one step, so that two runs
   * failing at the same moment are both counted. A count older than
   * `staleBefore` starts again from one.
   */
  fail(key: string, now: number, staleBefore: number): Promise<number>;
  /**
   * Closes the key, unless it is closed already. Returns true only to the one
   * caller that closed it, so that of several runs failing together exactly
   * one tells the owner.
   */
  close(key: string, closed: ExecWardError, now: number): Promise<boolean>;
  /** Notes which queue item the closure raised. */
  setEscalation(key: string, escalationId: string): Promise<void>;
  /** Records that an attempt was made, without changing anything else. */
  touch(key: string, now: number): Promise<void>;
  /** Forgets the key whatever its state: for a closure the owner dealt with, or one that ran out of time. */
  clear(key: string): Promise<void>;
  /**
   * Forgets the count unless the key is closed, in one step. For a run that succeeded: it was
   * admitted before it ran, and another run may have closed the project since. A closure is
   * never undone by a success.
   */
  clearOpen(key: string): Promise<void>;
}

export function memoryAttemptStore(): AttemptStore & { readonly states: Map<string, AttemptState> } {
  const states = new Map<string, AttemptState>();
  return {
    states,
    get: async (key) => states.get(key),
    async fail(key, now, staleBefore) {
      const before = states.get(key);
      const failures = before === undefined || before.updatedAt < staleBefore ? 1 : before.failures + 1;
      states.set(key, { ...(before?.closed ? { closed: before.closed } : {}), ...(before?.escalationId ? { escalationId: before.escalationId } : {}), failures, updatedAt: now });
      return failures;
    },
    async close(key, closed, now) {
      const before = states.get(key);
      if (before?.closed !== undefined) return false;
      states.set(key, { failures: before?.failures ?? 0, closed, updatedAt: now });
      return true;
    },
    async setEscalation(key, escalationId) {
      const before = states.get(key);
      if (before !== undefined) states.set(key, { ...before, escalationId });
    },
    async touch(key, now) {
      const before = states.get(key);
      if (before !== undefined) states.set(key, { ...before, updatedAt: now });
    },
    clear: async (key) => void states.delete(key),
    async clearOpen(key) {
      if (states.get(key)?.closed === undefined) states.delete(key);
    },
  };
}

export interface StoredAttemptDeps {
  readonly store: AttemptStore;
  readonly now: () => number;
  readonly maxRetries?: number;
  readonly idleMs?: number;
  /**
   * Called once when the project is closed to this caller. Returns the ID of
   * the owner's queue item, or `undefined` when the closure is not one for the queue.
   */
  readonly escalate?: (escalation: Escalation) => Promise<string | undefined>;
  /** Whether a queue item is still waiting for the owner. */
  readonly stillOpen?: (escalationId: string) => Promise<boolean>;
  /** Failures that are not the model's: refused by a switch the owner threw. */
  readonly notCounted?: (error: ExecWardError) => boolean;
}

/** The key for one caller in one project. Neither part can contain the separator. */
export function attemptKey(callerId: string, project: string): string {
  return `${callerId.replaceAll("\n", " ")}\n${project.replaceAll("\n", " ")}`;
}

/**
 * Reads where this caller stands in this project and returns the gate for one
 * run. Throws when the store cannot be read: the caller must then refuse the run.
 */
export async function storedAttemptGate(deps: StoredAttemptDeps, key: string): Promise<AttemptGate> {
  const maxRetries = deps.maxRetries ?? SELF_CORRECTION.maxRetries;
  const idleMs = deps.idleMs ?? ATTEMPT_IDLE_MS;
  const notCounted = deps.notCounted ?? ((error: ExecWardError) => error.code === "code_mode_off");
  const startedAt = deps.now();

  let state = await deps.store.get(key);
  if (state !== undefined && state.updatedAt < startedAt - idleMs) {
    await deps.store.clear(key);
    state = undefined;
  }
  if (state?.closed !== undefined && state.escalationId !== undefined && deps.stillOpen !== undefined && !(await deps.stillOpen(state.escalationId))) {
    // The owner dealt with it, or its time ran out.
    await deps.store.clear(key);
    state = undefined;
  }

  let failures = state?.failures ?? 0;
  let closed = state?.closed;

  async function close(reason: Escalation["reason"], error: ExecWardError, runId: string, refusal: ExecWardError): Promise<void> {
    closed = refusal;
    // Written before anyone is told: the next run must find it closed, and telling the owner takes time.
    // Seen on production on 2026-11-24, when it was written after: a run started in the gap and ran.
    const first = await deps.store.close(key, refusal, deps.now());
    // Another run failing at the same moment closed it first and is telling the owner.
    if (!first) return;
    try {
      const escalationId = await deps.escalate?.({ reason, error, runId });
      if (escalationId !== undefined) await deps.store.setEscalation(key, escalationId);
    } catch {
      // Closed whether or not anyone could be told.
    }
  }

  return {
    blocked: () => closed,
    retries: () => failures,
    remaining: () => (closed ? 0 : Math.max(0, maxRetries - failures)),
    async settle(output) {
      const now = deps.now();
      if (closed) {
        // An attempt while closed: the wait to reopen starts again.
        await deps.store.touch(key, now);
        return;
      }
      if (output.status === "completed" || output.status === "paused") {
        // Only an open count: this run was admitted earlier, and the project may have been closed since.
        if (failures > 0) await deps.store.clearOpen(key);
        failures = 0;
        return;
      }
      const error = output.error;
      if (notCounted(error)) return;
      if (ERROR_CODES[error.code].security) {
        return close("security", error, output.report.runId, { code: error.code, message: "this project was closed to this client by a security failure; it has been escalated to the owner" });
      }
      failures = await deps.store.fail(key, now, now - idleMs);
      if (failures > maxRetries) {
        await close("retries_exhausted", error, output.report.runId, {
          code: "quota_exceeded",
          message: `the retry limit was reached (${maxRetries} retries after a failure); it has been escalated to the owner, and further runs in this project are refused for now`,
        });
      }
    },
  };
}
