/**
 * Alerts (task 3.1.10; governance: monitoring).
 *
 * Five ways a run can end are worth the owner knowing about at once: a policy
 * denial, a quota or spend cap reached, the circuit breaker tripping, a tool
 * whose definition changed, and a sandbox fault. Each run already produces one
 * metric (./metrics.ts). This file reads that metric and, for those five:
 *
 *   - writes one line named `execward_alert` to the platform's log, every time;
 *   - sends the owner one email, at most once an hour for each kind.
 *
 * The email follows the rule in ../console/notify.ts: fixed words and a link to
 * the console. It names the kind of event and nothing else: no project, no
 * tool, no error text.
 *
 * An alert can never fail a run, and never throws.
 */
import type { QuotaStore } from "../broker/quotas";
import type { Email, Mailer } from "../console/notify";
import type { ErrorCode } from "../contracts/errors";
import type { MetricsSink, RunMetric } from "./metrics";

/** The error codes that raise an alert, and the fixed words an email uses for each. */
export const ALERT_KINDS = {
  policy_denied: "a call was refused under the policy table",
  quota_exceeded: "a quota or spend cap was reached",
  circuit_open: "the circuit breaker ended a run",
  definition_changed: "a tool's definition no longer matches its pin",
  sandbox_fault: "the sandbox failed",
} as const satisfies Partial<Record<ErrorCode, string>>;

export type AlertKind = keyof typeof ALERT_KINDS;

/** The name every alert line carries in the log. */
export const ALERT_EVENT = "execward_alert";

const HOUR_MS = 60 * 60 * 1000;

/** Emails of one kind in one clock hour. The log line is written every time. */
export const ALERT_EMAILS_PER_KIND_PER_HOUR = 1;

export interface Alert {
  readonly kind: AlertKind;
  readonly runId: string;
  readonly project: string;
}

/** The alert a run's metric calls for, or `undefined` when it calls for none. */
export function alertFor(metric: Pick<RunMetric, "errorCode" | "runId" | "project">): Alert | undefined {
  const code = metric.errorCode;
  if (code === undefined || !Object.hasOwn(ALERT_KINDS, code)) return undefined;
  return { kind: code as AlertKind, runId: metric.runId, project: metric.project };
}

export const ALERT_SUBJECT = "ExecWard: alert";

export function alertEmail(kind: AlertKind, baseUrl: string): Email {
  const url = new URL("/console", baseUrl);
  if (url.protocol !== "https:") throw new Error("the console link must use https");
  return {
    subject: ALERT_SUBJECT,
    body: `ExecWard alert: ${ALERT_KINDS[kind]}. Sign in to see what happened:\n\n${url.toString()}\n\nAt most one email an hour is sent for each kind of alert. Every alert is in the log.\n`,
  };
}

export interface AlertDeps {
  /** Where the alert line goes. Defaults to the platform's log. */
  readonly write?: (line: Readonly<Record<string, unknown>>) => void;
  /** Left out, no email is sent: the line is still written. */
  readonly mailer?: Mailer;
  /** Where the console is served. */
  readonly baseUrl: string;
  /** Counts emails by kind and hour, so every copy of the Worker shares one count. */
  readonly counts: QuotaStore;
  readonly now: () => number;
}

/** What became of one alert. */
export interface AlertResult {
  readonly alert: Alert;
  /** `sent`, `held` (one of this kind already went this hour), `off` (no mailer) or `failed`. */
  readonly email: "sent" | "held" | "off" | "failed";
}

/** Raises one alert: the line always, the email if this kind has not had one this hour. Never throws. */
export async function raiseAlert(alert: Alert, deps: AlertDeps): Promise<AlertResult> {
  let email: AlertResult["email"] = "off";
  if (deps.mailer) {
    try {
      const count = await deps.counts.add(`alert-email:${alert.kind}`, HOUR_MS, 1, deps.now());
      if (count > ALERT_EMAILS_PER_KIND_PER_HOUR) {
        email = "held";
      } else {
        await deps.mailer.send(alertEmail(alert.kind, deps.baseUrl));
        email = "sent";
      }
    } catch {
      // Not counted, or not sent. The line below still says the alert happened.
      email = "failed";
    }
  }
  try {
    (deps.write ?? ((line) => console.log(line)))({ event: ALERT_EVENT, kind: alert.kind, runId: alert.runId, project: alert.project, email });
  } catch {
    // Losing the line is better than losing the run.
  }
  return { alert, email };
}

/** A metrics sink that passes every metric on and raises an alert for those that call for one. */
export function alertingSink(inner: MetricsSink, deps: AlertDeps): MetricsSink {
  return {
    async export(metric) {
      try {
        await inner.export(metric);
      } catch {
        // A metric that cannot be sent must not cost the alert.
      }
      const alert = alertFor(metric);
      if (alert) await raiseAlert(alert, deps);
    },
  };
}
