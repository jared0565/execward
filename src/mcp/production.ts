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
import { auditLog, d1AuditStore, type AuditDatabase } from "../audit/log";
import { d1PolicyStore, type D1Like } from "../broker/policy-store";
import { githubPinsAndPolicy, githubUpstream } from "../connectors/github";
import { githubAppToken, type GithubAppSettings } from "../connectors/github-app";
import { principalFromAccess, type AccessContext } from "../console/access";
import type { WorkerLoader } from "../executor/dynamic-worker";
import { meter, type MeterSink } from "../meter/meter";
import { logMetricsSink } from "../metrics/metrics";
import { outboundFetch } from "../net/outbound";
import { registry } from "../registry/registry";
import { codeToolService, type CodeToolService } from "../service";
import { attemptKey, storedAttemptGate } from "../code-tool/stored-attempts";
import type { AttemptGate } from "../code-tool/attempts";
import { escalationQueue, triggerFor } from "../console/escalations";
import { d1AttemptStore, d1ControlStore, d1EscalationStore, d1ProjectStore, d1QuotaStore, type StateDatabase } from "../storage/d1-stores";
import { mcpAdapter, MCP_PATH } from "./adapter";

/** The one address the MCP server answers at. */
export const MCP_HOST = "mcp.execward.com";

export interface McpEnv {
  readonly LOADER: unknown;
  readonly DB: unknown;
  readonly MCP_ACCESS_AUD?: string;
  readonly OWNER_EMAIL?: string;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_INSTALLATION_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
}

/**
 * The GitHub App's settings as the latest request's environment gives them, and the one
 * token source that reads them. The source lives as long as this isolate, so an
 * installation token is minted about once an hour and not once a request.
 */
let githubSettings: GithubAppSettings = { appId: undefined, installationId: undefined, privateKeyPem: undefined };
const githubToken = githubAppToken({ settings: () => githubSettings, fetch: outboundFetch(), now: () => Date.now() });

/** The GitHub credential for this deployment: a token minted from the App's settings, or none. */
export function githubTokenFor(env: McpEnv): () => Promise<string | undefined> {
  githubSettings = { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY };
  return githubToken;
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
  githubSettings = { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY };
  // The GitHub tools' definitions are pinned from this build. Which of them may be called is the policy table's say.
  const { pins } = await githubPinsAndPolicy();
  const pinned = registry({ pins, current: async (path) => pins.find((pin) => pin.path === path)?.definition });
  return codeToolService({
    executor: dynamicWorkerExecutor(env.LOADER as WorkerLoader),
    policy: d1PolicyStore(env.DB as D1Like),
    projects: d1ProjectStore(db),
    quotas: d1QuotaStore(db),
    audit: d1AuditStore(db),
    control: d1ControlStore(db),
    // GitHub, read-only, through the guarded fetch. Until the App's three settings are stored, every call
    // fails with "no credential"; until a tool is in the policy table, no call gets this far.
    upstream: githubUpstream({ token: githubToken, fetch: outboundFetch() }),
    definitionFor: (record) => pinned.definitionFor(record),
    docsFor: (path) => pinned.docsFor(path),
    // No level named: the default, summary since Gate 1.
    meter: meter({ sink: logMeterSink }),
    metrics: logMetricsSink(),
    now,
    newRunId: () => crypto.randomUUID(),
  });
}

/**
 * Where one caller stands in one project: failed runs in a row, kept in the database
 * because each request may reach a different copy of the Worker (task 2.1.5). A
 * closure goes to the owner's queue, and reopens when the owner deals with it.
 */
export function productionAttempts(env: McpEnv, callerId: string, now: () => number): (project: string) => Promise<AttemptGate> {
  const db = env.DB as StateDatabase & AuditDatabase;
  const escalations = d1EscalationStore(db);
  const queue = escalationQueue({ store: escalations, control: d1ControlStore(db), audit: auditLog(d1AuditStore(db), now), now, newId: () => crypto.randomUUID() });
  return (project) =>
    storedAttemptGate(
      {
        store: d1AttemptStore(db),
        now,
        async escalate(escalation) {
          const trigger = triggerFor(escalation);
          if (trigger === undefined) return undefined;
          return (await queue.raise({ trigger, project, runId: escalation.runId, error: escalation.error })).id;
        },
        async stillOpen(id) {
          const item = await escalations.get(id);
          return item !== undefined && item.status === "open" && (item.expiresAt === null || item.expiresAt > now());
        },
      },
      attemptKey(callerId, project),
    );
}

function refused(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Answers a request that came to the MCP address. `service` is passed in by
 * tests; production builds it from the environment.
 */
export async function mcpResponse(
  request: Request,
  env: McpEnv,
  access: AccessContext | undefined,
  now: () => number,
  service?: CodeToolService,
  attemptsFor?: (callerId: string) => (project: string) => Promise<AttemptGate>,
): Promise<Response> {
  if (new URL(request.url).pathname !== MCP_PATH) return refused(404, "not_found");
  // A web page must never be able to drive the tool with the owner's sign-in.
  if (request.headers.has("origin")) return refused(403, "browser_requests_refused");
  const principal = await principalFromAccess(access, { audience: env.MCP_ACCESS_AUD, ownerEmail: env.OWNER_EMAIL });
  if (principal.kind !== "owner") return refused(401, "sign_in_required");
  // Which provider the client's model runs on is not known from sign-in (task 2.1.6), so the most cautious route applies.
  // With a service passed in and no count, a test is running: each call is then counted alone.
  const attempts = attemptsFor?.(principal.id) ?? (service === undefined ? productionAttempts(env, principal.id, now) : undefined);
  return mcpAdapter({ service: service ?? (await productionService(env, now)) }).serve(request, { providerRoute: "unknown", ...(attempts === undefined ? {} : { attemptsFor: attempts }) });
}
