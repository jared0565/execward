/**
 * The core Worker's entry point (task 1.1.1).
 *
 * It answers a health check, serves the owner console, serves the `code` tool
 * over MCP at its own address (src/mcp/production.ts), and on a timer it does
 * the housekeeping: closes expired escalations, applies retention and backs
 * the database up.
 *
 * The console answers only the owner, signed in through Cloudflare Access
 * (src/console/access.ts). Until Access is set up and its two settings are
 * stored, every console request is refused.
 */
import { auditLog, d1AuditStore, type AuditDatabase } from "./audit/log";
import { principalFromAccess, type AccessContext } from "./console/access";
import { clientChoices } from "./console/client-choice";
import { ownerConsole } from "./console/console";
import { escalationQueue } from "./console/escalations";
import { CONSOLE_PATH, consoleResponse } from "./console/http";
import { bindingMailer } from "./console/mailer";
import { CONTRACT_VERSION } from "./contracts/version";
import { EXECWARD_VERSION } from "./index";
import { MCP_PATH } from "./mcp/adapter";
import { quotaNetSavingStore } from "./meter/net-saving";
import { statsReport } from "./meter/stats";
import { githubWriteCheck } from "./connectors/github-write-check";
import { githubTokenFor, MCP_HOST, mcpResponse } from "./mcp/production";
import { outboundFetch } from "./net/outbound";
import { d1ControlStore, d1EscalationStore, d1ProjectStore, d1QuotaStore, d1StatsStore, listProjectRecords, setClientChoice, type StateDatabase } from "./storage/d1-stores";
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

/** Every request: the MCP address, then the console's addresses, then the rest. */
export async function handle(request: Request, env: Env, access: AccessContext | undefined, now: () => number = Date.now): Promise<Response> {
  const url = new URL(request.url);
  // The MCP address serves MCP and nothing else: no console, no health check.
  if (url.hostname === MCP_HOST) return mcpResponse(request, env, access, now);
  const path = url.pathname;
  // And MCP is served at no other address.
  if (path === MCP_PATH) return Response.json({ error: "not_found" }, { status: 404 });
  if (path !== CONSOLE_PATH && !path.startsWith(`${CONSOLE_PATH}/`)) return handleRequest(request);
  const db = env.DB as StateDatabase & AuditDatabase;
  const principal = await principalFromAccess(access, { audience: env.ACCESS_AUD, ownerEmail: env.OWNER_EMAIL });
  const control = d1ControlStore(db);
  const audit = auditLog(d1AuditStore(db), now);
  const console_ = ownerConsole({ control, audit, now });
  const queue = escalationQueue({ store: d1EscalationStore(db), control, audit, now, newId: () => crypto.randomUUID() });
  const mailer = bindingMailer(env.EMAIL, env.OWNER_EMAIL);
  // The owner's check that the GitHub credential cannot write. The answer goes in the audit log whatever it is.
  const writeCheck = async (owner: string, repo: string) => {
    const result = await githubWriteCheck({ token: githubTokenFor(env), fetch: outboundFetch() }, owner, repo);
    await audit.record({ kind: "console_change", runId: "none", project: "-", body: { action: "github_write_check", by: principal.kind === "owner" ? principal.id : principal.kind, repository: `${owner}/${repo}`, ...result } });
    return result;
  };
  // What each project's client has asked for. The owner records it; the service enforces it.
  const choices = clientChoices({ store: { get: (project) => d1ProjectStore(db).get(project), list: () => listProjectRecords(db), setChoice: (project, choice) => setClientChoice(db, project, choice) }, audit, now });
  return (await consoleResponse(request, { console: console_, queue, ...(mailer === undefined ? {} : { mailer }), githubWriteCheck: writeCheck, clientChoices: choices, netSaving: () => quotaNetSavingStore(d1QuotaStore(db)).report(now()), stats: () => statsReport(d1StatsStore(db), now()), principal, nonce })) ?? handleRequest(request);
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
