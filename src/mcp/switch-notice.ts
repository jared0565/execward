/**
 * Telling a client that a switch changed between two of its calls (task 2.1.4,
 * FR-18; PRD risk "mid-session toggling").
 *
 * Over MCP there is no session, so "mid-session" is read as "since this
 * caller's last call in this project" (the project owner's decision,
 * 2026-11-24). The settings that bear on the caller are remembered per caller
 * and project. When they differ at the next call, the reply carries one plain
 * line per change, whether the call then runs or is refused.
 *
 * The switches themselves are enforced elsewhere (src/console/control.ts) and
 * the rule is: any "off" stops the call. This file only reports.
 *
 * A notice is a courtesy, not a control. If the remembered settings cannot be
 * read or written, the call goes ahead with no notice.
 */
import type { ControlState, ControlStore } from "../console/control";

/** The switch settings that bear on one caller in one project. */
export interface SettingsSeen {
  readonly codeMode: boolean;
  readonly killed: boolean;
  readonly paused: boolean;
  readonly blockedTools: readonly string[];
}

export interface SettingsSeenStore {
  get(key: string): Promise<SettingsSeen | undefined>;
  put(key: string, settings: SettingsSeen, now: number): Promise<void>;
}

export function memorySettingsSeenStore(): SettingsSeenStore & { readonly seen: Map<string, SettingsSeen> } {
  const seen = new Map<string, SettingsSeen>();
  return { seen, get: async (key) => seen.get(key), put: async (key, settings) => void seen.set(key, settings) };
}

export function settingsFor(state: ControlState, project: string): SettingsSeen {
  return { codeMode: state.codeMode, killed: state.killed, paused: state.pausedProjects.includes(project), blockedTools: [...state.blockedTools].sort() };
}

/** At most this many lines in one reply. Past it, the rest are counted, not listed. */
export const MAX_NOTICES = 8;

const SINCE = "since your last call in this project";

/** One plain line per change between what a caller last saw and what holds now. */
export function noticesBetween(before: SettingsSeen, after: SettingsSeen): string[] {
  const lines: string[] = [];
  if (before.killed !== after.killed) lines.push(after.killed ? `The kill switch was set ${SINCE}. Nothing runs until the owner clears it.` : `The kill switch was cleared ${SINCE}.`);
  if (before.codeMode !== after.codeMode) lines.push(after.codeMode ? `Code Mode was switched on ${SINCE}.` : `Code Mode was switched off ${SINCE}. Calls are refused until the owner switches it on.`);
  if (before.paused !== after.paused) lines.push(after.paused ? `This project was paused ${SINCE}. Calls are refused until the owner resumes it.` : `This project was resumed ${SINCE}.`);
  const was = new Set(before.blockedTools);
  const now = new Set(after.blockedTools);
  // A tool's name is the owner's own data, but it is still shown as data: quoted, and cut to a sane length.
  const name = (tool: string): string => JSON.stringify(tool.slice(0, 120));
  for (const tool of after.blockedTools) if (!was.has(tool)) lines.push(`The tool ${name(tool)} was blocked ${SINCE}.`);
  for (const tool of before.blockedTools) if (!now.has(tool)) lines.push(`The tool ${name(tool)} was unblocked ${SINCE}.`);
  if (lines.length <= MAX_NOTICES) return lines;
  return [...lines.slice(0, MAX_NOTICES - 1), `${lines.length - (MAX_NOTICES - 1)} more switch changes are not listed.`];
}

export interface SwitchNoticeDeps {
  readonly store: SettingsSeenStore;
  readonly control: ControlStore;
  readonly now: () => number;
}

/**
 * The notices for one call, and the settings remembered for the next. A
 * caller's first call in a project has nothing to compare with and gets none.
 */
export async function switchNotices(deps: SwitchNoticeDeps, key: string, project: string): Promise<string[]> {
  try {
    const now = settingsFor(await deps.control.read(), project);
    const before = await deps.store.get(key);
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(now)) return [];
    await deps.store.put(key, now, deps.now());
    return before === undefined ? [] : noticesBetween(before, now);
  } catch {
    return [];
  }
}
