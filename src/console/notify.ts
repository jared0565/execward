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

/** The ID in a link must be random letters and digits, so the link itself carries no data. */
const SAFE_ID = /^[A-Za-z0-9_-]{16,64}$/;

function consoleUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  if (url.protocol !== "https:") throw new Error("the console link must use https");
  return url.toString();
}

export function urgentEmail(item: Pick<EscalationItem, "id">, baseUrl: string): Email {
  if (!SAFE_ID.test(item.id)) throw new Error("the item's ID is not safe to put in a link");
  return { subject: URGENT_SUBJECT, body: `Something in ExecWard needs your review now. Sign in to see it:\n\n${consoleUrl(baseUrl, `/escalations/${item.id}`)}\n` };
}

export function digestEmail(baseUrl: string): Email {
  return { subject: DIGEST_SUBJECT, body: `There are items waiting for your review in ExecWard. Sign in to see them:\n\n${consoleUrl(baseUrl, "/escalations")}\n` };
}

export interface NotifierDeps {
  readonly mailer: Mailer;
  /** Where the console is served, for example `https://console.example.com`. */
  readonly baseUrl: string;
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
  // When each item was last written about. Held in memory: after a restart a reminder may come early.
  const lastSent = new Map<string, number>();
  return {
    async raised(item) {
      if (!item.urgent) return;
      await deps.mailer.send(urgentEmail(item, deps.baseUrl));
      lastSent.set(item.id, item.createdAt);
    },
    async remind(open, now) {
      let sent = 0;
      for (const item of open) {
        const every = ESCALATION_MENU[item.trigger].reminderEveryMs;
        // Only urgent items are reminded one by one; the rest are in the daily digest already.
        if (item.status !== "open" || !item.urgent || every === null) continue;
        if (now - (lastSent.get(item.id) ?? item.createdAt) < every) continue;
        await deps.mailer.send(urgentEmail(item, deps.baseUrl));
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
