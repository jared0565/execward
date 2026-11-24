/**
 * The emergency stop (incident runbook step 1; FR-27).
 *
 * The kill switch is normally set from the console, which needs the owner's
 * mailbox and second factor. If the owner cannot sign in during an incident,
 * this sets it straight in the database, from a computer signed in to the
 * Cloudflare account.
 *
 * It can only stop. It cannot clear the kill switch, switch Code Mode on,
 * resume a project or unblock a tool: everything that lifts a protection
 * still needs the console.
 *
 * It goes through the same change as the console does: the version check, the
 * next version number, and an audit log entry on the chain. The entry names
 * who did it as the emergency stop, because the database cannot know who was
 * at the keyboard.
 */
import type { AuditLog } from "../audit/log";
import { changeControl } from "./console";
import type { ControlState, ControlStore } from "./control";

/** Who the audit log names. Not a person: whoever held the Cloudflare account at the time. */
export const EMERGENCY_ACTOR = "emergency-stop:cloudflare-account";

export interface EmergencyStopResult {
  readonly before: ControlState;
  readonly after: ControlState;
  /** False when the kill switch was already set: nothing was written. */
  readonly changed: boolean;
}

export async function emergencyStop(deps: { readonly control: ControlStore; readonly audit: AuditLog }, reason: string): Promise<EmergencyStopResult> {
  const before = await deps.control.read();
  // As with the console's own switch, a missing reason never delays a stop.
  const why = reason.trim().slice(0, 500) || "(no reason given)";
  const after = await changeControl(deps, { action: "kill", by: EMERGENCY_ACTOR, reason: why }, (state) => (state.killed ? undefined : { ...state, killed: true }));
  return { before, after, changed: after.version !== before.version };
}
