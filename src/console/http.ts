/**
 * The owner console over HTTP (tasks 1.6.1, 1.6.2, 1.6.3, 1.6.5; FR-49).
 *
 * Three addresses: the page, the current state, and one for actions. Each
 * goes through `ownerConsole`, which refuses anyone but the owner with recent
 * two-factor sign-in. This file adds what a browser needs on top: an action
 * must come from the console's own page, and the page may load nothing from
 * anywhere else.
 */
import { ConsoleAccessError, ConsoleChangeError, type OwnerConsole, type Principal } from "./console";
import type { ControlState } from "./control";
import type { EscalationItem, EscalationQueue } from "./escalations";
import { consolePage } from "./page";

export const CONSOLE_PATH = "/console";
/** A header a page on another site cannot add to a request without the browser asking first. */
export const CONSOLE_HEADER = "x-execward-console";
const MAX_BODY_CHARS = 4000;
const MAX_FIELD_CHARS = 200;

/**
 * What the page is given about a queue item: enough to decide, and no more. The run's
 * report and the error's own text stay in the audit log; they can hold a client's data.
 */
export interface QueueItemView {
  readonly id: string;
  readonly trigger: string;
  readonly project: string;
  readonly createdAt: number;
  readonly urgent: boolean;
  readonly expiresAt: number | null;
  /** When the owner chose to keep it as it is. The item stays open until a choice that closes it. */
  readonly acknowledgedAt?: number;
  readonly errorCode?: string;
  readonly toolPath?: string;
  readonly safeAction: string;
  readonly recommended: { readonly optionId: string; readonly rule: string };
  readonly options: readonly { readonly id: string; readonly label: string; readonly effect: string; readonly reversible: boolean; readonly needsReason: boolean }[];
}

export function queueItemView(item: EscalationItem): QueueItemView {
  return {
    id: item.id,
    trigger: item.trigger,
    project: item.project,
    createdAt: item.createdAt,
    urgent: item.urgent,
    expiresAt: item.expiresAt,
    ...(item.acknowledgedAt === undefined ? {} : { acknowledgedAt: item.acknowledgedAt }),
    ...(item.error === undefined ? {} : { errorCode: item.error.code }),
    ...(item.context.toolPath === undefined ? {} : { toolPath: item.context.toolPath }),
    safeAction: item.safeAction,
    recommended: item.recommended,
    options: item.options.map((option) => ({ id: option.id, label: option.label, effect: option.effect, reversible: option.reversible, needsReason: option.needsReason === true })),
  };
}

export interface ConsoleHttpDeps {
  readonly console: OwnerConsole;
  /** The escalation queue (tasks 1.6.6, 1.6.9). Without it the console has no queue address. */
  readonly queue?: EscalationQueue;
  readonly principal: Principal;
  /** A fresh random value per response, for the page's one script and one style block. */
  readonly nonce: () => string;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...extra,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: headers({ "content-type": "application/json; charset=utf-8", "content-security-policy": "default-src 'none'" }) });
}

function refused(error: unknown): Response {
  if (error instanceof ConsoleAccessError) return json({ error: "forbidden", message: error.message }, 403);
  if (error instanceof ConsoleChangeError) return json({ error: "not_changed", message: error.message }, 409);
  // Anything else is ours. Its text is not for the browser.
  return json({ error: "failed", message: "the console could not do that" }, 500);
}

class BadRequest extends Error {}

function field(body: Record<string, unknown>, name: string, { required = true }: { required?: boolean } = {}): string {
  const value = body[name];
  if (value === undefined && !required) return "";
  if (typeof value !== "string") throw new BadRequest(`"${name}" must be text`);
  const text = value.trim();
  if (required && text === "") throw new BadRequest(`"${name}" is required`);
  if (text.length > MAX_FIELD_CHARS) throw new BadRequest(`"${name}" is too long`);
  return text;
}

async function act(console_: OwnerConsole, principal: Principal, body: Record<string, unknown>): Promise<ControlState> {
  const action = field(body, "action");
  switch (action) {
    case "kill":
      return console_.kill(principal, field(body, "reason", { required: false }));
    case "clear_kill":
      return console_.clearKill(principal, field(body, "reason"));
    case "code_mode_on":
      return console_.setCodeMode(principal, true);
    case "code_mode_off":
      return console_.setCodeMode(principal, false);
    case "complete_onboarding": {
      const profile = field(body, "profile");
      if (profile !== "lightweight" && profile !== "formal") throw new BadRequest("choose a governance profile: lightweight or formal");
      // Every other onboarding field keeps its safe default from here.
      return console_.completeOnboarding(principal, { profile });
    }
    case "pause_project":
      return console_.pauseProject(principal, field(body, "project"), field(body, "reason"));
    case "resume_project":
      return console_.resumeProject(principal, field(body, "project"), field(body, "reason"));
    case "block_tool":
      return console_.blockTool(principal, field(body, "tool"), field(body, "reason"));
    case "unblock_tool":
      return console_.unblockTool(principal, field(body, "tool"), field(body, "reason"));
    default:
      throw new BadRequest("that is not a console action");
  }
}

/** Why a request to change something did not come from the console's own page, or `undefined` when it did. */
function notFromThePage(request: Request, url: URL): string | undefined {
  if (request.headers.get("origin") !== url.origin) return "the request did not come from the console";
  if (request.headers.get(CONSOLE_HEADER) !== "1") return "the request did not come from the console";
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return "the request must be JSON";
  return undefined;
}

/** Answers a request under `/console`, or returns `undefined` when the address is not the console's. */
export async function consoleResponse(request: Request, deps: ConsoleHttpDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== CONSOLE_PATH && !path.startsWith(`${CONSOLE_PATH}/`)) return undefined;

  try {
    if (path === CONSOLE_PATH && request.method === "GET") {
      // The gate comes first: the page is not shown to anyone who could not use it.
      await deps.console.state(deps.principal);
      const nonce = deps.nonce();
      const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      return new Response(consolePage(nonce), { headers: headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": policy }) });
    }
    if (path === `${CONSOLE_PATH}/state` && request.method === "GET") {
      return json({ state: await deps.console.state(deps.principal) });
    }
    if (path === `${CONSOLE_PATH}/queue` && request.method === "GET" && deps.queue !== undefined) {
      const items = await deps.queue.list(deps.principal);
      return json({ items: items.map(queueItemView), proposals: await deps.queue.proposals(deps.principal) });
    }
    if (path === `${CONSOLE_PATH}/action` && request.method === "POST") {
      // Who is asking is settled before anything the request carries is read.
      await deps.console.state(deps.principal);
      const problem = notFromThePage(request, url);
      if (problem !== undefined) return json({ error: "forbidden", message: problem }, 403);
      const text = await request.text();
      if (text.length > MAX_BODY_CHARS) return json({ error: "bad_request", message: "the request is too long" }, 400);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "bad_request", message: "the request is not JSON" }, 400);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "bad_request", message: "the request is not a JSON object" }, 400);
      const sent = body as Record<string, unknown>;
      if (sent.action === "resolve" && deps.queue !== undefined) {
        // The owner's choice on a queue item. The queue checks the principal again and applies the choice.
        const resolved = await deps.queue.resolve(deps.principal, field(sent, "id"), field(sent, "option"), field(sent, "reason", { required: false }) || undefined);
        return json({ state: await deps.console.state(deps.principal), resolved: { id: resolved.id, status: resolved.status } });
      }
      return json({ state: await act(deps.console, deps.principal, sent) });
    }
  } catch (error) {
    if (error instanceof BadRequest) return json({ error: "bad_request", message: error.message }, 400);
    return refused(error);
  }
  return json({ error: "not_found" }, 404);
}
