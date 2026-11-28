/**
 * The change set (task 3.1.2, FR-42): the writes one script asked for, recorded
 * and not done.
 *
 * A script that calls a tier-1 or tier-2 tool gets a placeholder back, and the
 * call is kept here. When the script has ended, the whole set is checked once
 * more and, if nothing is wrong, exactly those calls are sent, in the order the
 * script made them. Nothing in this file sends anything: it holds the record,
 * the hash and the checks. The broker does the sending.
 *
 * The owner's decision of 2026-11-28 (docs/decisions/3.1.1-pause-and-resume.md):
 * a script is never stopped part-way and never run twice. It runs to its end
 * with its writes recorded.
 */
import type { ErrorCode } from "../contracts/errors";
import { scriptMayCall, type PolicyRecord } from "../contracts/policy";
import { canonicalJson } from "../registry/definition";

/** How much one run may ask to write. The reasons are in docs/decisions/3.1.2-dry-run.md. */
export const CHANGE_SET_LIMITS = {
  /** Writes in one change set. */
  maxWrites: 20,
  /** All the arguments of one change set together, as JSON. */
  maxBytes: 256 * 1024,
} as const;

/** One write a script asked for. Nothing has been sent. */
export interface PlannedWrite {
  /** Its place in the set, from 1, in the order the script made the calls. */
  readonly index: number;
  readonly path: string;
  readonly server: string;
  readonly tool: string;
  readonly tier: 1 | 2;
  /** The tool's pinned definition when the call was checked. */
  readonly definitionHash: string;
  /**
   * The arguments as canonical JSON, taken when the call was checked. This text
   * is what is hashed and what is sent: the script keeps no hold on it.
   */
  readonly argsJson: string;
}

/** What a script is handed in place of a write's result. Fixed words and a number. */
export interface DryRunAnswer {
  readonly dryRun: true;
  /** The write's place in the change set. */
  readonly change: number;
  readonly note: string;
}

export const DRY_RUN_NOTE =
  "Recorded, not done. Writes are made together after the script ends, if every check passes. This is not the tool's result: nothing here can be used as an ID, a number or a URL.";

export function dryRunAnswer(index: number): DryRunAnswer {
  return { dryRun: true, change: index, note: DRY_RUN_NOTE };
}

/**
 * The arguments of one call, as the text that is hashed and later sent, or
 * `undefined` when they have no JSON form (a value that points back at itself,
 * for example).
 */
export function argumentsJson(args: unknown): string | undefined {
  let json: string | undefined;
  try {
    // A call with no arguments is an empty object, as it is for the schema check.
    json = JSON.stringify(args === undefined ? {} : args);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  // Made from a parsed copy, so what is kept is plain data and nothing the script still holds.
  return canonicalJson(JSON.parse(json) as unknown);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One hash over the whole set: every write's tool, pinned definition and exact
 * arguments, in order. An approval (FR-30, task 3.1.5) will be bound to this.
 */
export function changeSetHash(writes: readonly PlannedWrite[]): Promise<string> {
  return sha256Hex(
    canonicalJson(writes.map((write) => ({ index: write.index, path: write.path, tier: write.tier, definitionHash: write.definitionHash, argsJson: write.argsJson }))),
  );
}

export function changeSetBytes(writes: readonly PlannedWrite[]): number {
  const encoder = new TextEncoder();
  return writes.reduce((sum, write) => sum + encoder.encode(write.argsJson).length, 0);
}

/** Why a change set may not be committed. The code is the error the run ends with. */
export interface ChangeSetProblem {
  readonly code: Extract<ErrorCode, "policy_denied" | "quota_exceeded" | "definition_changed">;
  /** Names tools and counts only: never an argument. */
  readonly message: string;
}

/**
 * The checks on the set as a whole, made after the script has ended and just
 * before anything is sent. `current` is each tool's policy record as it stands
 * now, which may not be what it was when the call was recorded.
 *
 * An empty answer means the set may be committed as it is.
 */
export function changeSetProblems(writes: readonly PlannedWrite[], current: ReadonlyMap<string, PolicyRecord | undefined>): ChangeSetProblem[] {
  const problems: ChangeSetProblem[] = [];
  if (writes.length > CHANGE_SET_LIMITS.maxWrites) {
    problems.push({ code: "quota_exceeded", message: `the change set holds ${writes.length} writes; the limit is ${CHANGE_SET_LIMITS.maxWrites}` });
  }
  const bytes = changeSetBytes(writes);
  if (bytes > CHANGE_SET_LIMITS.maxBytes) {
    problems.push({ code: "quota_exceeded", message: `the change set's arguments come to ${bytes} bytes; the limit is ${CHANGE_SET_LIMITS.maxBytes}` });
  }
  const seen = new Set<string>();
  writes.forEach((write, position) => {
    // The set is sent in the order it was recorded, so the numbering must be that order.
    if (write.index !== position + 1) problems.push({ code: "policy_denied", message: `write ${position + 1} of the change set is out of order` });
    const record = current.get(write.path);
    if (record === undefined) {
      problems.push({ code: "policy_denied", message: `"${write.path}" no longer has a policy record` });
    } else if (record.definitionHash !== write.definitionHash) {
      problems.push({ code: "definition_changed", message: `the definition of "${write.path}" changed after the write was recorded` });
    } else if (record.tier !== write.tier || !scriptMayCall(record)) {
      problems.push({ code: "policy_denied", message: `the policy for "${write.path}" changed after the write was recorded` });
    }
    // A tier-2 action needs the owner's approval, and there is nowhere to ask for it yet (task 3.1.4).
    if (write.tier === 2) problems.push({ code: "policy_denied", message: `"${write.path}" needs the owner's approval, which cannot be asked for yet` });
    // The same call twice is far more often a loop that went wrong than something meant.
    const key = `${write.path}\n${write.argsJson}`;
    if (seen.has(key)) problems.push({ code: "policy_denied", message: `the change set makes the same call to "${write.path}" twice` });
    seen.add(key);
  });
  return problems;
}
