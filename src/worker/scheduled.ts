/**
 * What the core Worker does on its timer (tasks 1.4.4, 1.4.5, 1.6.8, 1.3.8).
 *
 * The timer fires every five minutes. Every firing does the frequent round:
 * close escalations past their time limit. The first firing of a UTC day that
 * finds no backup for that day also does the daily round: apply retention to
 * the audit log, check the reviewer model against known answers (task 2.2.4),
 * sweep old counters, then back the database up.
 *
 * The day's backup is the marker that the daily round is done. If it fails,
 * the next firing tries again, so a missed or failed round mends itself
 * within five minutes instead of waiting a day.
 *
 * What was done is written to the audit log, as counts: always for a daily
 * round, and for a frequent round only when it did something or failed.
 */
import { auditLog, d1AuditStore, type AuditDatabase } from "../audit/log";
import { backUp, backupKey, type BackupBucket, type BackupDatabase, type BackupResult } from "../backup";
import { escalationQueue } from "../console/escalations";
import { bindingMailer, CONSOLE_URL } from "../console/mailer";
import { notifier } from "../console/notify";
import { runMaintenance, type JobResult } from "../maintenance";
import { STATS_KEEP_MS } from "../meter/stats";
import { d1ControlStore, d1EscalationStore, d1QuotaStore, d1StatsStore, sweepQuotaCounters, type StateDatabase } from "../storage/d1-stores";
import { runGoldenCheck } from "../verify/golden";
import { productionReviewer } from "../verify/production";

/** How often the timer fires. Must match the schedule in wrangler.jsonc. */
export const SCHEDULE_MS = 5 * 60 * 1000;

export interface ScheduledEnv {
  readonly DB: unknown;
  readonly BACKUPS: BackupBucket;
  /** The email binding and the owner's address. Without both, nothing is sent and the jobs are skipped. */
  readonly EMAIL?: unknown;
  readonly OWNER_EMAIL?: string;
  /** Verification's key. Without it the daily check of the reviewer finds it cannot ask, and counts nothing. */
  readonly VERIFY_OPENAI_API_KEY?: string;
}

export interface ScheduledResult {
  readonly frequent: JobResult[];
  /** Present when this firing did the daily round. */
  readonly daily?: JobResult[];
  readonly backup?: BackupResult | { readonly error: string };
}

export async function runScheduled(env: ScheduledEnv, now: number, newId: () => string = () => crypto.randomUUID(), outbound?: typeof fetch): Promise<ScheduledResult> {
  const db = env.DB as StateDatabase & AuditDatabase & BackupDatabase;
  const audit = d1AuditStore(db);
  const log = auditLog(audit, () => now);
  const escalations = d1EscalationStore(db);
  const queue = escalationQueue({ store: escalations, control: d1ControlStore(db), audit: log, now: () => now, newId });
  const mailer = bindingMailer(env.EMAIL, env.OWNER_EMAIL);
  const deps = {
    audit,
    queue,
    escalations,
    ...(mailer === undefined ? {} : { notifier: notifier({ mailer, baseUrl: CONSOLE_URL, tickMs: SCHEDULE_MS }) }),
    sweepCounters: (at: number) => sweepQuotaCounters(db, at),
    trimStats: (at: number) => d1StatsStore(db).trim(at - STATS_KEEP_MS),
    // FR-45: the reviewer model is given its known-answer cases, at most once a day.
    checkReviewer: () => {
      const reviewing = productionReviewer({ key: () => env.VERIFY_OPENAI_API_KEY, quotas: d1QuotaStore(db), now: () => now, ...(outbound ? { fetch: outbound } : {}) });
      return runGoldenCheck({ reviewer: reviewing.forTheCheck, store: reviewing.golden, queue, audit: log, now: () => now });
    },
    now: () => now,
  };

  const frequent = await runMaintenance(deps, "frequent");
  let result: ScheduledResult = { frequent };

  let backedUpToday: boolean;
  try {
    backedUpToday = (await env.BACKUPS.list({ prefix: backupKey(now) })).objects.length > 0;
  } catch {
    // The bucket cannot be read. The daily round is tried; its backup will say why it failed.
    backedUpToday = false;
  }
  if (!backedUpToday) {
    const daily = await runMaintenance(deps, "daily");
    let backup: ScheduledResult["backup"];
    try {
      backup = await backUp(db, env.BACKUPS, now);
    } catch (error) {
      backup = { error: error instanceof Error ? error.message.slice(0, 200) : "failed" };
    }
    result = { frequent, daily, backup };
  }

  const eventful = result.daily !== undefined || frequent.some((job) => !job.ok || !job.detail.startsWith("0 "));
  if (eventful) {
    // The record of the round is itself best-effort: failing to write it must not undo the work.
    await log
      .record({ kind: "maintenance", runId: `maintenance-${new Date(now).toISOString()}`, project: "system", body: { ...result } })
      .catch(() => undefined);
  }
  return result;
}
