/**
 * The core Worker's entry point (task 1.1.1).
 *
 * It answers a health check, serves the owner console, and on a timer it does
 * the housekeeping: closes expired escalations, applies retention and backs
 * the database up. The `code` tool is not served yet.
 *
 * The console answers only the owner, signed in through Cloudflare Access
 * (src/console/access.ts). Until Access is set up and its two settings are
 * stored, every console request is refused.
 */
import { auditLog, d1AuditStore, type AuditDatabase } from "./audit/log";
import { principalFromAccess, type AccessContext } from "./console/access";
import { ownerConsole } from "./console/console";
import { CONSOLE_PATH, consoleResponse } from "./console/http";
import { CONTRACT_VERSION } from "./contracts/version";
import { EXECWARD_VERSION } from "./index";
import { d1ControlStore, type StateDatabase } from "./storage/d1-stores";
import type { Env } from "./worker/bindings";
import { runScheduled, type ScheduledEnv } from "./worker/scheduled";

export function handleRequest(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ name: "execward", version: EXECWARD_VERSION, contracts: CONTRACT_VERSION });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every request: the console's addresses first, then the rest. */
export async function handle(request: Request, env: Env, access: AccessContext | undefined, now: () => number = Date.now): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== CONSOLE_PATH && !path.startsWith(`${CONSOLE_PATH}/`)) return handleRequest(request);
  const db = env.DB as StateDatabase & AuditDatabase;
  const principal = await principalFromAccess(access, { audience: env.ACCESS_AUD, ownerEmail: env.OWNER_EMAIL });
  const console_ = ownerConsole({ control: d1ControlStore(db), audit: auditLog(d1AuditStore(db), now), now });
  return (await consoleResponse(request, { console: console_, principal, nonce })) ?? handleRequest(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: { readonly access?: AccessContext }): Promise<Response> {
    return handle(request, env, ctx.access);
  },
  // The timer: every five minutes (see ./worker/scheduled).
  async scheduled(controller: { readonly scheduledTime: number }, env: Env): Promise<void> {
    await runScheduled(env as unknown as ScheduledEnv, controller.scheduledTime);
  },
};
