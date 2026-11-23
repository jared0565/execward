/**
 * The core Worker's entry point (task 1.1.1).
 *
 * It answers a health check, and on a timer it does the housekeeping: closes
 * expired escalations, applies retention and backs the database up. The `code`
 * tool is not served yet. It has no public address (see wrangler.jsonc) and
 * holds no credentials. Its bindings are the Worker Loader, its own database
 * and the backup bucket.
 */
import { CONTRACT_VERSION } from "./contracts/version";
import { EXECWARD_VERSION } from "./index";
import type { Env } from "./worker/bindings";
import { runScheduled, type ScheduledEnv } from "./worker/scheduled";

export function handleRequest(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ name: "execward", version: EXECWARD_VERSION, contracts: CONTRACT_VERSION });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
  // Requests use nothing from the environment yet.
  fetch(request: Request): Response {
    return handleRequest(request);
  },
  // The timer: every five minutes (see ./worker/scheduled).
  async scheduled(controller: { readonly scheduledTime: number }, env: Env): Promise<void> {
    await runScheduled(env as unknown as ScheduledEnv, controller.scheduledTime);
  },
};
