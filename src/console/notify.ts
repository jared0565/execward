/**
 * Notifications (task 1.6.7; FR-44, FR-49, flag 11).
 *
 * An email says that something is waiting and gives a link. Nothing else:
 * no project, no tool, no error text, no figures. Email is not a place for
 * client data, and the link leads to the console, which asks for sign-in.
 *
 * Urgent items are sent at once, one email each, and are never batched.
 * Everything else waits for the daily digest.
 */
import { ESCALATION_MENU, type EscalationItem } from "./escalations";

export interface Email {
  readonly subject: string;
  readonly body: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export const URGENT_SUBJECT = "ExecWard: an item needs your review now";
export const DIGEST_SUBJECT = "ExecWard: items are waiting for your review";

function consoleUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  if (url.protocol !== "https:") throw new Error("the console link must use https");
  return url.toString();
}

/** The link leads to the console and carries nothing about the item, not even its ID (changed 2026-11-24). */
export function urgentEmail(baseUrl: string): Email {
  return { subject: URGENT_SUBJECT, body: `Something in ExecWard needs your review now. Sign in to see it:\n\n${consoleUrl(baseUrl, "/console")}\n` };
}

export function digestEmail(baseUrl: string): Email {
  return { subject: DIGEST_SUBJECT, body: `There are items waiting for your review in ExecWard. Sign in to see them:\n\n${consoleUrl(baseUrl, "/console")}\n` };
}

export interface NotifierDeps {
  readonly mailer: Mailer;
  /** Where the console is served, for example `https://console.example.com`. */
  readonly baseUrl: string;
  /**
   * How often `remind` is run. When set, a reminder is decided from the clock alone: it is due on
   * the first run after the item was raised, and then on each run in which the item's age passes a
   * whole number of reminder periods. Do not also call `raised` for the same items, or the first
   * email is sent twice. A Worker on a timer
   * keeps no memory between runs, and without this it would send again on every run.
   */
  readonly tickMs?: number;
}

export interface Notifier {
  /** For the queue's `onRaised`: sends at once if the item is urgent, and does nothing otherwise. */
  raised(item: EscalationItem): Promise<void>;
  /** Run once a day with the open items. Sends one email if any non-urgent item is waiting. */
  digest(open: readonly EscalationItem[]): Promise<boolean>;
  /**
   * Run every few minutes with the open items. Sends again for each item whose
   * trigger asks for reminders and whose last email is old enough. Returns how many were sent.
   */
  remind(open: readonly EscalationItem[], now: number): Promise<number>;
}

export function notifier(deps: NotifierDeps): Notifier {
  // When each item was last written about. Held in memory, so used only when no `tickMs` is given.
  const lastSent = new Map<string, number>();
  return {
    async raised(item) {
      if (!item.urgent) return;
      await deps.mailer.send(urgentEmail(deps.baseUrl));
      lastSent.set(item.id, item.createdAt);
    },
    async remind(open, now) {
      let sent = 0;
      for (const item of open) {
        const every = ESCALATION_MENU[item.trigger].reminderEveryMs;
        // Only urgent items are reminded one by one; the rest are in the daily digest already.
        if (item.status !== "open" || !item.urgent || every === null) continue;
        const age = now - item.createdAt;
        const due =
          deps.tickMs === undefined
            ? now - (lastSent.get(item.id) ?? item.createdAt) >= every
            : // The first run after the item appeared is its first email; after that, once per period.
              (age >= 0 && age < deps.tickMs) || (age >= every && Math.floor(age / every) !== Math.floor((age - deps.tickMs) / every));
        if (!due) continue;
        await deps.mailer.send(urgentEmail(deps.baseUrl));
        lastSent.set(item.id, now);
        sent += 1;
      }
      return sent;
    },
    async digest(open) {
      if (!open.some((item) => item.status === "open" && !item.urgent)) return false;
      await deps.mailer.send(digestEmail(deps.baseUrl));
      return true;
    },
  };
}
