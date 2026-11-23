/**
 * The release gate (task 1.7.4, FR-47, FR-48).
 *
 * The last step before a reply is handed over. It runs fixed checks on
 * exactly what would be sent. A failed check withholds the reply, and nothing
 * later can overrule it: there is no input that turns a fail into a pass.
 *
 * What code cannot decide (is this summary right? does it meet the criteria
 * the request set?) is for an independent reviewer (FR-48, Phase 2). Until
 * one exists, a reply that passes the fixed checks is released and marked
 * `unreviewed`, never `passed`.
 */
import type { ExecWardError } from "../contracts/errors";
import { DATA_CLASSES, type DataClass } from "../contracts/policy";
import { SECRET_PATTERNS } from "../static-check/check";

export interface GateCheck {
  readonly name: "format" | "size" | "secret_scan" | "data_class";
  readonly passed: boolean;
  /** Why it failed. Never quotes the content that failed. */
  readonly detail?: string;
}

export interface GateVerdict {
  readonly checks: readonly GateCheck[];
  /** Set when a check failed: the error returned in place of the reply. */
  readonly failure?: ExecWardError;
}

export interface GateInput {
  /** Everything in the reply that a script could have written. */
  readonly result?: unknown;
  readonly logs?: readonly string[];
  readonly errorMessage?: string;
  /** The highest class the run read, what the project may return, and whether content was withheld. */
  readonly read: DataClass | undefined;
  readonly allowed: DataClass;
  readonly masked: boolean;
  readonly maxResultBytes: number;
}

/** Room for the notice that wraps a result that was cut. */
export const NOTICE_ALLOWANCE_BYTES = 1_024;

function secretIn(text: string): string | undefined {
  for (const { name, pattern } of SECRET_PATTERNS) {
    // A fresh expression each time: a shared one with the `g` flag remembers where it stopped.
    if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)) return name;
  }
  return undefined;
}

export function releaseGate(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  let failure: ExecWardError | undefined;
  const fail = (name: GateCheck["name"], code: ExecWardError["code"], detail: string): void => {
    checks.push({ name, passed: false, detail });
    failure ??= { code, message: `the release gate withheld the reply: ${detail}` };
  };

  // Format: what is sent must be plain JSON.
  let resultText: string | undefined;
  try {
    resultText = input.result === undefined ? "" : JSON.stringify(input.result);
  } catch {
    resultText = undefined;
  }
  if (resultText === undefined) fail("format", "sandbox_fault", "the result is not valid JSON");
  else checks.push({ name: "format", passed: true });

  // Size: the cap is applied earlier; this confirms it held.
  const bytes = new TextEncoder().encode(resultText ?? "").length;
  if (bytes > input.maxResultBytes + NOTICE_ALLOWANCE_BYTES) fail("size", "sandbox_fault", `the result is ${bytes} bytes, over the limit`);
  else checks.push({ name: "size", passed: true });

  // Secret scan: over everything a script could have written into the reply.
  const written = [resultText ?? "", ...(input.logs ?? []), input.errorMessage ?? ""].join("\n");
  const secret = secretIn(written);
  if (secret !== undefined) fail("secret_scan", "policy_denied", `it contains what looks like ${secret}`);
  else checks.push({ name: "secret_scan", passed: true });

  // Data class: content above the project's class must already have been withheld.
  const above = input.read !== undefined && DATA_CLASSES.indexOf(input.read) > DATA_CLASSES.indexOf(input.allowed);
  if (above && !input.masked) fail("data_class", "policy_denied", `the run read ${String(input.read)} data and the reply was not withheld`);
  else checks.push({ name: "data_class", passed: true });

  return { checks, ...(failure ? { failure } : {}) };
}
