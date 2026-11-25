/**
 * Scheduled housekeeping: the jobs that several tasks left "for a schedule"
 * (1.4.4 retention, 1.6.7 digest and reminders, 1.6.8 expiry, 1.3.8 counter sweep).
 *
 * Two rounds. The frequent one, every few minutes, closes escalations past
 * their time limit and sends reminders. The daily one applies retention to
 * the audit log, sends the digest and sweeps old counters.
 *
 * Each job stands alone: one failing does not stop the others, and the report
 * says which ran. Nothing here is called by anything yet; a deployed Worker's
 * scheduled handler will call it.
 */
import { applyRetention, type AuditStore } from "./audit/log";
import type { EscalationItem, EscalationQueue, EscalationStore } from "./console/escalations";
import type { Notifier } from "./console/notify";

export type MaintenanceRound = "frequent" | "daily";

export interface MaintenanceDeps {
  readonly audit: AuditStore;
  readonly queue: Pick<EscalationQueue, "expire">;
  readonly escalations: Pick<EscalationStore, "all">;
  readonly notifier?: Pick<Notifier, "digest" | "remind">;
  readonly sweepCounters?: (now: number) => Promise<void>;
  /** Removes stats rows past their keeping time (task 2.3.1). */
  readonly trimStats?: (now: number) => Promise<void>;
  /** The daily check of the reviewer model (task 2.2.4). Returns what it did, as counts. */
  readonly checkReviewer?: () => Promise<string>;
  readonly now: () => number;
}

export interface JobResult {
  readonly job: "expire_escalations" | "send_reminders" | "apply_retention" | "check_reviewer" | "send_digest" | "sweep_counters" | "trim_stats";
  readonly ok: boolean;
  /** What the job did, as counts. Never content. */
  readonly detail: string;
}

export async function runMaintenance(deps: MaintenanceDeps, round: MaintenanceRound): Promise<JobResult[]> {
  const results: JobResult[] = [];
  const job = async (name: JobResult["job"], work: () => Promise<string>): Promise<void> => {
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

  await job("apply_retention", async () => {
    const done = await applyRetention(deps.audit, deps.now());
    return `${done.contentExpired} entries had their text removed, ${done.entriesRemoved} entries removed`;
  });
  // Before the digest, so that an item it raises is in the same day's email.
  const checkReviewer = deps.checkReviewer;
  if (checkReviewer) await job("check_reviewer", checkReviewer);
  if (notifier) await job("send_digest", async () => ((await notifier.digest(await open())) ? "sent" : "nothing waiting"));
  const sweep = deps.sweepCounters;
  if (sweep) await job("sweep_counters", async () => (await sweep(deps.now()), "swept"));
  const trim = deps.trimStats;
  if (trim) await job("trim_stats", async () => (await trim(deps.now()), "trimmed"));
  return results;
}
