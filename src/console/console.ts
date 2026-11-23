/**
 * The owner console's actions (tasks 1.6.1, 1.6.2, 1.6.3, 1.6.5, 1.6.9; FR-49, FR-52).
 *
 * This is the logic behind the console, not its pages or its sign-in. Every
 * action takes a principal: who is asking, as established by sign-in. An
 * action is refused unless the principal is the owner with recent two-factor
 * sign-in. A model's credential is never an owner's, so nothing a model holds
 * can reach these actions.
 *
 * Every change is versioned and written to the audit log with what it was
 * before and after.
 */
import type { AuditLog } from "../audit/log";
import type { DataClass } from "../contracts/policy";
import type { MeterLevel } from "../meter/meter";
import { ONBOARDING_DEFAULTS, type ControlState, type ControlStore, type GovernanceProfile, type OnboardingRecord } from "./control";

/** Who is asking. Established by sign-in, never by anything in a request body. */
export type Principal =
  | { readonly kind: "owner"; readonly id: string; /** When two-factor sign-in was last completed. */ readonly twoFactorAt: number | undefined }
  /** Any credential a model or its client holds: an MCP token, an API key, a session of the test app. */
  | { readonly kind: "model_client"; readonly id: string }
  | { readonly kind: "anonymous" };

export class ConsoleAccessError extends Error {
  override readonly name = "ConsoleAccessError";
}

export class ConsoleChangeError extends Error {
  override readonly name = "ConsoleChangeError";
}

/** How long a two-factor sign-in lasts before it must be repeated. */
export const TWO_FACTOR_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface ConsoleDeps {
  readonly control: ControlStore;
  readonly audit: AuditLog;
  readonly now: () => number;
  readonly twoFactorMaxAgeMs?: number;
}

export interface OnboardingInput {
  /** Must be chosen. Everything else has a safe default. */
  readonly profile: GovernanceProfile;
  readonly approvers?: readonly string[];
  readonly approvedProviders?: readonly string[];
  readonly projectDataClasses?: Readonly<Record<string, DataClass>>;
  readonly meterLevel?: MeterLevel;
  readonly outboundAllowlist?: readonly string[];
}

export interface OwnerConsole {
  state(principal: Principal): Promise<ControlState>;
  completeOnboarding(principal: Principal, input: OnboardingInput): Promise<ControlState>;
  setCodeMode(principal: Principal, on: boolean): Promise<ControlState>;
  /** The kill switch. Stops everything at once. */
  kill(principal: Principal, reason: string): Promise<ControlState>;
  /** Clears the kill switch. Code Mode stays as it was. */
  clearKill(principal: Principal, reason: string): Promise<ControlState>;
  pauseProject(principal: Principal, project: string, reason: string): Promise<ControlState>;
  resumeProject(principal: Principal, project: string, reason: string): Promise<ControlState>;
  blockTool(principal: Principal, path: string, reason: string): Promise<ControlState>;
  unblockTool(principal: Principal, path: string, reason: string): Promise<ControlState>;
}

/** Throws unless the principal is the owner with recent two-factor sign-in. */
export function requireOwner(principal: Principal, now: number, maxAgeMs: number = TWO_FACTOR_MAX_AGE_MS): asserts principal is Extract<Principal, { kind: "owner" }> {
  if (principal.kind === "model_client") throw new ConsoleAccessError("a model's credential cannot be used in the owner console");
  if (principal.kind !== "owner") throw new ConsoleAccessError("sign in to use the owner console");
  const at = principal.twoFactorAt;
  if (at === undefined) throw new ConsoleAccessError("two-factor sign-in is required");
  // A time in the future is not a sign-in that happened.
  if (!Number.isFinite(at) || at > now || now - at > maxAgeMs) throw new ConsoleAccessError("two-factor sign-in has expired; sign in again");
}

function without<T>(items: readonly T[], item: T): T[] {
  return items.filter((entry) => entry !== item);
}

/**
 * Applies one change with the store's version check, so two changes made at
 * once cannot overwrite each other. For code inside ExecWard that has already
 * decided the change is allowed; console actions go through `ownerConsole`.
 */
export async function changeControl(
  deps: Pick<ConsoleDeps, "control" | "audit">,
  change: { readonly action: string; readonly by: string; readonly reason?: string; readonly project?: string },
  apply: (state: ControlState) => ControlState | undefined,
): Promise<ControlState> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await deps.control.read();
    const changed = apply(before);
    // Nothing to change: no new version, no log entry.
    if (changed === undefined) return before;
    const after: ControlState = { ...changed, version: before.version + 1 };
    if (!(await deps.control.write(after, before.version))) continue;
    try {
      await deps.audit.record({
        kind: "console_change",
        runId: `control-v${after.version}`,
        project: change.project ?? "-",
        body: { action: change.action, by: change.by, ...(change.reason === undefined ? {} : { reason: change.reason }), version: after.version, before, after },
      });
    } catch {
      // The change stands: a kill switch must work even when the log does not. It is reported.
      throw new ConsoleChangeError(`the change was made (version ${after.version}) but could not be written to the audit log`);
    }
    return after;
  }
  throw new ConsoleChangeError("the control state kept changing; nothing was changed, try again");
}

export function ownerConsole(deps: ConsoleDeps): OwnerConsole {
  const authorised = (principal: Principal): string => {
    requireOwner(principal, deps.now(), deps.twoFactorMaxAgeMs);
    return principal.id;
  };
  const needReason = (reason: string): string => {
    if (reason.trim() === "") throw new ConsoleChangeError("a reason is required");
    return reason.trim().slice(0, 500);
  };

  return {
    async state(principal) {
      authorised(principal);
      return deps.control.read();
    },

    async completeOnboarding(principal, input) {
      const by = authorised(principal);
      if (input.profile !== "lightweight" && input.profile !== "formal") throw new ConsoleChangeError("choose a governance profile: lightweight or formal");
      const record: OnboardingRecord = {
        profile: input.profile,
        // The owner is always an approver.
        approvers: [...new Set([by, ...(input.approvers ?? ONBOARDING_DEFAULTS.approvers)])],
        approvedProviders: [...(input.approvedProviders ?? ONBOARDING_DEFAULTS.approvedProviders)],
        projectDataClasses: { ...(input.projectDataClasses ?? ONBOARDING_DEFAULTS.projectDataClasses) },
        meterLevel: input.meterLevel ?? ONBOARDING_DEFAULTS.meterLevel,
        outboundAllowlist: [...(input.outboundAllowlist ?? ONBOARDING_DEFAULTS.outboundAllowlist)],
        completedAt: deps.now(),
      };
      // Onboarding records settings. It does not switch Code Mode on.
      return changeControl(deps, { action: "complete_onboarding", by }, (state) => ({ ...state, onboarding: record }));
    },

    async setCodeMode(principal, on) {
      const by = authorised(principal);
      return changeControl(deps, { action: on ? "code_mode_on" : "code_mode_off", by }, (state) => {
        if (on && state.onboarding === undefined) throw new ConsoleChangeError("Code Mode stays off until onboarding is complete");
        return state.codeMode === on ? undefined : { ...state, codeMode: on };
      });
    },

    async kill(principal, reason) {
      const by = authorised(principal);
      // The reason is asked for but never allowed to delay the switch.
      return changeControl(deps, { action: "kill", by, reason: reason.trim().slice(0, 500) || "(no reason given)" }, (state) => (state.killed ? undefined : { ...state, killed: true }));
    },

    async clearKill(principal, reason) {
      const by = authorised(principal);
      return changeControl(deps, { action: "clear_kill", by, reason: needReason(reason) }, (state) => (state.killed ? { ...state, killed: false } : undefined));
    },

    async pauseProject(principal, project, reason) {
      const by = authorised(principal);
      return changeControl(deps, { action: "pause_project", by, reason: needReason(reason), project }, (state) =>
        state.pausedProjects.includes(project) ? undefined : { ...state, pausedProjects: [...state.pausedProjects, project] },
      );
    },

    async resumeProject(principal, project, reason) {
      const by = authorised(principal);
      return changeControl(deps, { action: "resume_project", by, reason: needReason(reason), project }, (state) =>
        state.pausedProjects.includes(project) ? { ...state, pausedProjects: without(state.pausedProjects, project) } : undefined,
      );
    },

    async blockTool(principal, path, reason) {
      const by = authorised(principal);
      return changeControl(deps, { action: "block_tool", by, reason: needReason(reason) }, (state) =>
        state.blockedTools.includes(path) ? undefined : { ...state, blockedTools: [...state.blockedTools, path] },
      );
    },

    async unblockTool(principal, path, reason) {
      const by = authorised(principal);
      return changeControl(deps, { action: "unblock_tool", by, reason: needReason(reason) }, (state) =>
        state.blockedTools.includes(path) ? { ...state, blockedTools: without(state.blockedTools, path) } : undefined,
      );
    },
  };
}
