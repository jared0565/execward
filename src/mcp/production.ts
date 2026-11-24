/**
 * The MCP server as production serves it (task 2.1.2, FR-25, FR-10).
 *
 * Sign-in is Cloudflare Access, as for the console, by the project owner's
 * decision on 2026-11-24. The MCP address has its own Access application.
 * A CLI signs the owner in through a browser; Access gives the CLI a token
 * that works only for this address, checks it on every request, and hands the
 * Worker `ctx.access`. The Worker never sees the CLI's token and never passes
 * any token on.
 *
 * What is checked here, each failing closed:
 * - The request came to the MCP address and to the MCP path.
 * - It did not come from a web page. A CLI sends no `Origin`; a page does.
 * - Access authenticated it for the MCP application, not for the console or
 *   anything else: the audiences differ, so a sign-in to one is not a sign-in
 *   to the other, in either direction.
 * - The person is the owner. A service token is refused.
 *
 * What Access does not give, and ExecWard does instead: there are no
 * permission levels in the sign-in. What a client may do is decided by the
 * policy table on every call. See docs/decisions/2.1.2-cli-sign-in.md.
 */
import { d1AuditStore, type AuditDatabase } from "../audit/log";
import { d1PolicyStore, type D1Like } from "../broker/policy-store";
import { principalFromAccess, type AccessContext } from "../console/access";
import type { WorkerLoader } from "../executor/dynamic-worker";
import { meter, type MeterSink } from "../meter/meter";
import { logMetricsSink } from "../metrics/metrics";
import { codeToolService, type CodeToolService } from "../service";
import { d1ControlStore, d1ProjectStore, d1QuotaStore, type StateDatabase } from "../storage/d1-stores";
import { mcpAdapter, MCP_PATH } from "./adapter";

/** The one address the MCP server answers at. */
export const MCP_HOST = "mcp.execward.com";

export interface McpEnv {
  readonly LOADER: unknown;
  readonly DB: unknown;
  readonly MCP_ACCESS_AUD?: string;
  readonly OWNER_EMAIL?: string;
}

/** Each run's token estimate, as one line in the platform's log, beside its metric line. */
const logMeterSink: MeterSink = {
  async write(record) {
    try {
      console.log({ event: "execward_meter", ...record });
    } catch {
      // A lost line never fails a run.
    }
  },
};

/** The code tool with every store on the production database. */
export async function productionService(env: McpEnv, now: () => number): Promise<CodeToolService> {
  const db = env.DB as StateDatabase & AuditDatabase;
  // Loaded when first needed: the sandbox module exists only inside the Workers runtime.
  const { dynamicWorkerExecutor } = await import("../executor/dynamic-worker");
  return codeToolService({
    executor: dynamicWorkerExecutor(env.LOADER as WorkerLoader),
    policy: d1PolicyStore(env.DB as D1Like),
    projects: d1ProjectStore(db),
    quotas: d1QuotaStore(db),
    audit: d1AuditStore(db),
    control: d1ControlStore(db),
    // No upstream is connected to production yet. With no tool in the policy table, no call reaches these.
    upstream: async () => {
      throw new Error("no upstream is connected");
    },
    definitionFor: async () => undefined,
    docsFor: async () => undefined,
    // No level named: the default, summary since Gate 1.
    meter: meter({ sink: logMeterSink }),
    metrics: logMetricsSink(),
    now,
    newRunId: () => crypto.randomUUID(),
  });
}

function refused(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Answers a request that came to the MCP address. `service` is passed in by
 * tests; production builds it from the environment.
 */
export async function mcpResponse(request: Request, env: McpEnv, access: AccessContext | undefined, now: () => number, service?: CodeToolService): Promise<Response> {
  if (new URL(request.url).pathname !== MCP_PATH) return refused(404, "not_found");
  // A web page must never be able to drive the tool with the owner's sign-in.
  if (request.headers.has("origin")) return refused(403, "browser_requests_refused");
  const principal = await principalFromAccess(access, { audience: env.MCP_ACCESS_AUD, ownerEmail: env.OWNER_EMAIL });
  if (principal.kind !== "owner") return refused(401, "sign_in_required");
  // Which provider the client's model runs on is not known from sign-in (task 2.1.6), so the most cautious route applies.
  return mcpAdapter({ service: service ?? (await productionService(env, now)) }).serve(request, { providerRoute: "unknown" });
}
