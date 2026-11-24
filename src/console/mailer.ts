/**
 * Sending the link-only emails (task 1.6.7; FR-44, FR-49).
 *
 * The owner chose on 2026-11-24 to send from a subdomain of execward.com with
 * Cloudflare's email sending, so the domain's own mail is not affected. The
 * Worker's email binding may send from one address only (see wrangler.jsonc).
 * Mail goes to one address: the owner's, which is a secret.
 *
 * What an email may say is decided in ./notify. This file only hands it over.
 */
import type { Email, Mailer } from "./notify";

/** The Worker's email binding, as the platform supplies it. */
export interface EmailBinding {
  send(message: { readonly from: string; readonly to: string; readonly subject: string; readonly text: string }): Promise<unknown>;
}

/** The one address ExecWard sends from. Must equal the binding's allowed sender. */
export const ALERT_SENDER = "alerts@notify.execward.com";
/** Where the console is served. Every link in an email leads here, and to nowhere else. */
export const CONSOLE_URL = "https://console.execward.com";

export const TEST_EMAIL: Email = {
  subject: "ExecWard: test email",
  body: `This is a test, sent from the ExecWard console at your request. Nothing needs your attention.\n\n${CONSOLE_URL}/console\n`,
};

/** A mailer over the binding, or `undefined` when email is not set up. One recipient, fixed when it is built. */
export function bindingMailer(binding: unknown, to: string | undefined, from: string = ALERT_SENDER): Mailer | undefined {
  const recipient = to?.trim() ?? "";
  // One plain address. Anything else, such as a list or a header smuggled in on a new line, is not set up.
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(recipient)) return undefined;
  if (typeof binding !== "object" || binding === null || typeof (binding as EmailBinding).send !== "function") return undefined;
  const email = binding as EmailBinding;
  return {
    async send(message) {
      await email.send({ from, to: recipient, subject: message.subject, text: message.body });
    },
  };
}
