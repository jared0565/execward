/**
 * The control state: the switches the owner holds (tasks 1.6.2 to 1.6.5,
 * FR-16, FR-17, FR-27, FR-52).
 *
 * Everything starts in its safe position: Code Mode off, onboarding not done.
 * The state is read before every run and before every call a script makes,
 * so a switch thrown mid-run takes effect at the script's next call.
 *
 * Nothing here involves a model. The kill switch is a field the owner sets;
 * it works whether or not any model is reachable.
 */
import type { ExecWardError } from "../contracts/errors";
import type { DataClass } from "../contracts/policy";
import type { MeterLevel } from "../meter/meter";

export type GovernanceProfile = "lightweight" | "formal";

/** What the owner records at onboarding (FR-52). */
export interface OnboardingRecord {
  /** Changes review cadence and the records kept. Never a security control. */
  readonly profile: GovernanceProfile;
  readonly approvers: readonly string[];
  /** Keys of `PROVIDER_ROUTES` the owner has confirmed. */
  readonly approvedProviders: readonly string[];
  readonly projectDataClasses: Readonly<Record<string, DataClass>>;
  readonly meterLevel: MeterLevel;
  readonly outboundAllowlist: readonly string[];
  readonly completedAt: number;
}

/** Every onboarding field's safe default. The profile has none: it must be chosen. */
export const ONBOARDING_DEFAULTS = {
  approvers: [] as readonly string[],
  approvedProviders: [] as readonly string[],
  projectDataClasses: {} as Readonly<Record<string, DataClass>>,
  meterLevel: "off" as MeterLevel,
  outboundAllowlist: [] as readonly string[],
} as const;

export interface ControlState {
  /** The global switch (FR-16). */
  readonly codeMode: boolean;
  /** The kill switch (FR-27). While set, nothing runs, whatever else is on. */
  readonly killed: boolean;
  /** Projects paused until a security exception is reviewed (FR-44). */
  readonly pausedProjects: readonly string[];
  /** Tools blocked after their definition changed (FR-46). */
  readonly blockedTools: readonly string[];
  readonly onboarding?: OnboardingRecord;
  /** Goes up by one with every change. */
  readonly version: number;
}

export const INITIAL_CONTROL_STATE: ControlState = { codeMode: false, killed: false, pausedProjects: [], blockedTools: [], version: 0 };

export interface ControlStore {
  read(): Promise<ControlState>;
  /** Writes `next` only if the stored version is still `expectedVersion`. False when it was not. */
  write(next: ControlState, expectedVersion: number): Promise<boolean>;
}

export function memoryControlStore(initial: ControlState = INITIAL_CONTROL_STATE): ControlStore & { current(): ControlState } {
  let state = initial;
  return {
    current: () => state,
    read: async () => state,
    async write(next, expectedVersion) {
      if (state.version !== expectedVersion) return false;
      state = next;
      return true;
    },
  };
}

/** Why a run may not start or carry on, or `undefined` when it may. */
export type RunGate = (project: string) => Promise<ExecWardError | undefined>;

export function runGate(store: ControlStore): RunGate {
  return async (project) => {
    let state: ControlState;
    try {
      state = await store.read();
    } catch {
      // Fail closed: if the switches cannot be read, they are treated as off.
      return { code: "code_mode_off", message: "the control state is unavailable, so nothing is run" };
    }
    if (state.killed) return { code: "code_mode_off", message: "ExecWard was stopped by the owner with the kill switch" };
    if (!state.codeMode) return { code: "code_mode_off", message: "Code Mode is switched off" };
    if (state.pausedProjects.includes(project)) return { code: "code_mode_off", message: "this project is paused until a security exception is reviewed" };
    return undefined;
  };
}

/** The same check before each call a script makes, plus whether that one tool is blocked. */
export function callGate(store: ControlStore, project: string): (path: string) => Promise<ExecWardError | undefined> {
  const gate = runGate(store);
  return async (path) => {
    const stopped = await gate(project);
    if (stopped) return stopped;
    // `gate` has just read the state, so this read is expected to succeed; if it does not, fail closed.
    try {
      const state = await store.read();
      if (state.blockedTools.includes(path)) return { code: "policy_denied", message: "the tool is blocked until its changed definition is reviewed" };
    } catch {
      return { code: "code_mode_off", message: "the control state is unavailable, so nothing is run" };
    }
    return undefined;
  };
}

export type AppMode = "on" | "off" | "stopped";

/** What the test app should offer a model: the `code` tool, direct calls, or nothing. */
export async function appMode(store: ControlStore, project: string): Promise<AppMode> {
  try {
    const state = await store.read();
    if (state.killed || state.pausedProjects.includes(project)) return "stopped";
    return state.codeMode ? "on" : "off";
  } catch {
    return "stopped";
  }
}
