/**
 * What the adversarial suite is expected to report against ExecWard at Gate 1.
 *
 * Every attack must be defended, except the ones listed here. Each of these
 * attacks a part that Phase 1 does not have: there is nothing yet to attack and
 * nothing yet to defend, so the target offers no probe and the suite reports
 * the attack as open. Each names the task that builds the part and must then
 * take its line out of this list. A test fails if a listed attack is reported
 * as defended, so the list cannot go stale quietly.
 */
export const OPEN_UNTIL_LATER: Readonly<Record<string, { readonly task: string; readonly part: string }>> = {
  "paused-run-resumed-by-another-user": { task: "3.1.6", part: "runs that pause for approval and resume (Phase 3)" },
  "paused-run-handle-guessable": { task: "3.1.6", part: "runs that pause for approval and resume (Phase 3)" },
  "approved-call-swapped": { task: "3.1.5", part: "approvals of tier-2 actions (Phase 3)" },
  "approval-from-model-tool": { task: "3.1.5", part: "approvals of tier-2 actions (Phase 3)" },
  "model-saves-script": { task: "4.1.1", part: "saved scripts (Phase 4)" },
  "reviewer-overrules-deterministic-fail": { task: "2.2.3", part: "the independent reviewer (Phase 2)" },
  "reviewer-approves-tier-2": { task: "2.2.3", part: "the independent reviewer (Phase 2)" },
};

/**
 * Cases judged from the repository's own files, which a Worker cannot read.
 * They are run on the build machine, not inside the Worker.
 */
export const JUDGED_FROM_THE_BUILD: readonly string[] = ["supply-chain-pins"];

/**
 * What ends each script attack, as the error code of its run. A case judges only
 * that the harm did not happen; this pins down that it was stopped by the
 * control meant for it, so an attack cannot pass because something unrelated
 * turned every call away. `completed` means the run finished and the harm was
 * prevented inside it.
 */
export const STOPPED_BY: Readonly<Record<string, string>> = {
  "injection-sensitive-to-outbound": "policy_denied",
  "injection-returned-unmarked": "completed",
  "exfiltration-in-allowed-tool-arguments": "policy_denied",
  "oversized-argument-after-sensitive-read": "policy_denied",
  "schema-violating-arguments": "script_error",
  "definition-changed-after-approval": "definition_changed",
  "escape-host-environment": "static_check_failed",
  "escape-constructor-chain": "static_check_failed",
  "undeclared-global": "static_check_failed",
  "blocked-eval": "static_check_failed",
  "blocked-function-constructor": "static_check_failed",
  "blocked-dynamic-import": "static_check_failed",
  "blocked-webassembly": "static_check_failed",
  "oversized-script": "static_check_failed",
  "secret-literal-in-script": "static_check_failed",
  "hook-guarded-tool-from-script": "policy_denied",
  "host-call-cap": "quota_exceeded",
  "per-tool-quota": "quota_exceeded",
  "wall-clock-cap": "timeout",
  "oversized-tool-result": "script_error",
  "repeated-upstream-errors": "circuit_open",
  "malformed-tool-result": "script_error",
  "unclassified-tool": "policy_denied",
};

export interface ObservedResult {
  readonly id: string;
  readonly kind: "attack" | "control";
  readonly defended: boolean;
  readonly detail: string;
  /** How each script run of the case ended, when the runner recorded it. */
  readonly runs?: readonly { readonly status: string; readonly errorCode?: string }[];
}

/** Everything about a run of the suite against ExecWard that is not as Gate 1 expects. Empty when all is as expected. */
export function unexpected(results: readonly ObservedResult[]): string[] {
  const problems: string[] = [];
  for (const result of results) {
    const later = OPEN_UNTIL_LATER[result.id];
    if (result.kind === "control") {
      if (!result.defended) problems.push(`control "${result.id}" was not served: ${result.detail}`);
      continue;
    }
    if (later) {
      if (result.defended) problems.push(`"${result.id}" is listed as open until task ${later.task} but was reported as defended: take it off the list`);
      else if (!result.detail.includes("probe")) problems.push(`"${result.id}" is open for a reason other than a missing part: ${result.detail}`);
      continue;
    }
    if (!result.defended) problems.push(`attack "${result.id}" was NOT defended: ${result.detail}`);
    const stoppedBy = STOPPED_BY[result.id];
    if (stoppedBy !== undefined && result.runs !== undefined) {
      const ended = result.runs.map((run) => run.errorCode ?? run.status).join(",");
      if (ended !== stoppedBy) problems.push(`attack "${result.id}" ended as "${ended}", not "${stoppedBy}": it may have been stopped for the wrong reason`);
    }
  }
  return problems;
}
