/**
 * Scheduled housekeeping: the jobs that several tasks left "for a schedule"
 * (1.4.4 retention, 1.6.7 digest and reminders, 1.6.8 expiry, 1.3.8 counter sweep).
 *
 * Two rounds. The frequent one, every few minutes, closes escalations past
 * their time limit and sends reminders. The daily one applies retention to
 * the audit log, checks the reviewer, sends the digest, and removes old
 * counters, stats rows and closed queue items.
 *
 * Each job stands alone: one failing does not stop the others, and the report
 * says which ran. The production Worker's timer calls it (./worker/scheduled.ts).
 *
 * While the kill switch is set, the jobs that delete are held: an incident's
 * evidence must not age out while it is being looked into (incident runbook,
 * step 3; the owner's decision of 2026-11-27).
 */
import { applyRetention, type AuditStore } from "./audit/log";
import { trimEscalations, type EscalationItem, type EscalationQueue, type EscalationStore } from "./console/escalations";
import type { Notifier } from "./console/notify";

export type MaintenanceRound = "frequent" | "daily";

export interface MaintenanceDeps {
  readonly audit: AuditStore;
  readonly queue: Pick<EscalationQueue, "expire">;
  /** With `remove`, closed items past their keeping time are removed in the daily round. */
  readonly escalations: Pick<EscalationStore, "all"> & Partial<Pick<EscalationStore, "remove">>;
  /**
   * Whether deletion is held: true while the kill switch is set. Not being able to tell
   * counts as held. Left out, nothing is ever held.
   */
  readonly held?: () => Promise<boolean>;
  readonly notifier?: Pick<Notifier, "digest" | "remind">;
  readonly sweepCounters?: (now: number) => Promise<void>;
  /** Removes stats rows past their keeping time (task 2.3.1). */
  readonly trimStats?: (now: number) => Promise<void>;
  /** The daily check of the reviewer model (task 2.2.4). Returns what it did, as counts. */
  readonly checkReviewer?: () => Promise<string>;
  readonly now: () => number;
}

export interface JobResult {
  readonly job: "expire_escalations" | "send_reminders" | "apply_retention" | "check_reviewer" | "send_digest" | "sweep_counters" | "trim_stats" | "trim_queue";
  readonly ok: boolean;
  /** What the job did, as counts. Never content. */
  readonly detail: string;
}

/**
 * The daily jobs that only remove what is past its keeping time. Running one again does no
 * harm, and one that failed is owed until it works. The others are not repeated: the digest
 * would be a second email, and the reviewer's check is once a day by its own rule.
 */
export const REPEATABLE_DAILY_JOBS: readonly JobResult["job"][] = ["apply_retention", "sweep_counters", "trim_stats", "trim_queue"];

/** What a held job reports. It counts as done: it is not owed, and runs on the first day the switch is clear. */
export const HELD_DETAIL = "held: the kill switch is set, so nothing was deleted";

/** Whether the jobs that delete are held for this round. Asked once, so every job of the round gets the same answer. */
export async function deletionHeld(deps: Pick<MaintenanceDeps, "held">): Promise<boolean> {
  if (deps.held === undefined) return false;
  try {
    return await deps.held();
  } catch {
    // Deleting is the thing that cannot be undone, so not knowing means not deleting.
    return true;
  }
}

/** `only`, when given, names the jobs of the round to run; the rest are left out of the report. */
export async function runMaintenance(deps: MaintenanceDeps, round: MaintenanceRound, only?: readonly JobResult["job"][]): Promise<JobResult[]> {
  const results: JobResult[] = [];
  const job = async (name: JobResult["job"], work: () => Promise<string>): Promise<void> => {
    if (only !== undefined && !only.includes(name)) return;
    try {
      results.push({ job: name, ok: true, detail: await work() });
    } catch (error) {
      // The message of a storage error can name tables, never their content.
      results.push({ job: name, ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "failed" });
    }
  };
  const open = async (): Promise<EscalationItem[]> => (await deps.escalations.all()).filter((item) => item.status === "open");
  const notifier = deps.notifier;

  if (round === "frequent") {
    await job("expire_escalations", async () => `${(await deps.queue.expire()).length} closed`);
    if (notifier) await job("send_reminders", async () => `${await notifier.remind(await open(), deps.now())} sent`);
    return results;
  }

  const held = await deletionHeld(deps);
  // A job that deletes. While deletion is held it does nothing and says so.
  const deleting = (name: JobResult["job"], work: () => Promise<string>): Promise<void> => job(name, held ? async () => HELD_DETAIL : work);

  await deleting("apply_retention", async () => {
    const done = await applyRetention(deps.audit, deps.now());
    return `${done.contentExpired} entries had their text removed, ${done.entriesRemoved} entries removed`;
  });
  // Before the digest, so that an item it raises is in the same day's email.
  const checkReviewer = deps.checkReviewer;
  if (checkReviewer) await job("check_reviewer", checkReviewer);
  if (notifier) await job("send_digest", async () => ((await notifier.digest(await open())) ? "sent" : "nothing waiting"));
  const sweep = deps.sweepCounters;
  if (sweep) await deleting("sweep_counters", async () => (await sweep(deps.now()), "swept"));
  const trim = deps.trimStats;
  if (trim) await deleting("trim_stats", async () => (await trim(deps.now()), "trimmed"));
  const { all, remove } = deps.escalations;
  if (remove) await deleting("trim_queue", async () => `${await trimEscalations({ all, remove }, deps.now())} closed items removed`);
  return results;
}
