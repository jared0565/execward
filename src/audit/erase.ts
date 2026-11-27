/**
 * Deleting one project's records on request (FR-21; the client notice, "How long it is kept").
 *
 * A client can ask for the records of work done for them to be deleted. Two
 * stores hold a project's content: the audit log, whose entries hold scripts,
 * arguments and error text, and the owner's queue, whose items can hold an
 * error's words, a run report and figures. This clears both and records that
 * it was done, with the reason and who did it, as counts only.
 *
 * What it leaves, and why:
 *   - Each audit entry's outline (number, time, kind, run and project names)
 *     stays until it ages out at 90 days. Entries are chained, and taking one
 *     out of the middle would break the chain.
 *   - Stats rows hold the project's name beside counts, never content, and age
 *     out at 90 days.
 *   - The daily backups hold what was removed for up to 7 days more.
 *
 * It refuses while an item of the project is still open in the queue. An open
 * item is something the owner has not dealt with, perhaps a security
 * exception that has the project paused, and deleting it would lose that.
 */
import type { EscalationStore } from "../console/escalations";
import type { AuditLog, AuditStore } from "./log";

/** Who the audit log names. Not a person: whoever held the Cloudflare account at the time. */
export const ERASE_ACTOR = "erase-command:cloudflare-account";

/** The same shape as a project's name everywhere else: nothing that could be mistaken for anything but a name. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class EraseRefused extends Error {
  override readonly name = "EraseRefused";
}

export interface EraseResult {
  /** Audit entries whose content was removed. */
  readonly entriesErased: number;
  /** Closed queue items removed. */
  readonly queueItemsRemoved: number;
  /** False when the project had nothing to delete: nothing was written, not even a record of the request. */
  readonly changed: boolean;
}

export interface EraseDeps {
  readonly audit: AuditStore;
  readonly log: AuditLog;
  readonly escalations: EscalationStore;
}

export async function eraseProjectRecords(deps: EraseDeps, project: string, reason: string): Promise<EraseResult> {
  if (!PROJECT_NAME.test(project)) throw new EraseRefused("that is not a project name");
  const why = reason.trim().slice(0, 500);
  // Unlike a stop, a deletion cannot be undone, so it always says why.
  if (why === "") throw new EraseRefused("a reason is required: who asked for the deletion, and when");

  const items = (await deps.escalations.all()).filter((item) => item.project === project);
  const open = items.filter((item) => item.status === "open").length;
  if (open > 0) throw new EraseRefused(`${open} item${open === 1 ? "" : "s"} of this project ${open === 1 ? "is" : "are"} still waiting in the queue; deal with ${open === 1 ? "it" : "them"} in the console first`);

  for (const item of items) await deps.escalations.remove(item.id);
  const entriesErased = await deps.audit.eraseProject(project);
  // A name with nothing under it, a mistyped one for instance, leaves no entry behind.
  if (items.length === 0 && entriesErased === 0) return { entriesErased: 0, queueItemsRemoved: 0, changed: false };
  // Counts, the reason and who: never anything of the client's.
  await deps.log.record({ kind: "project_logs_deleted", runId: "none", project, body: { by: ERASE_ACTOR, reason: why, entriesErased, queueItemsRemoved: items.length } });
  return { entriesErased, queueItemsRemoved: items.length, changed: true };
}
