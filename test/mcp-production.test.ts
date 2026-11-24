import { describe, expect, it } from "vitest";
import type { AccessContext } from "../src/console/access";
import type { CodeToolOutput } from "../src/contracts/code-tool";
import { MCP_HOST, mcpResponse } from "../src/mcp/production";
import type { CallerContext } from "../src/service";
import { handle } from "../src/worker";
import type { Env } from "../src/worker/bindings";

const NOW = 1_800_000_000_000;
const MCP_AUD = "m".repeat(64);
const CONSOLE_AUD = "c".repeat(64);
// An invented address: the owner's real one is in no file.
const OWNER = "owner@example.test";
const ENV = { LOADER: {}, DB: {}, BACKUPS: {}, ACCESS_AUD: CONSOLE_AUD, MCP_ACCESS_AUD: MCP_AUD, OWNER_EMAIL: OWNER } as Env;

const REPORT: CodeToolOutput["report"] = {
  runId: "run-1",
  scriptHash: "a".repeat(64),
  callsByTool: {},
  recordsRead: 0,
  recordsWritten: 0,
  errors: [],
  retries: 0,
  assertions: { passed: 0, failed: 0 },
  sideEffects: [],
  verification: "unreviewed",
  durationMs: 1,
};

function access(over: { aud?: string; identity?: Record<string, unknown> | null } = {}): AccessContext {
  return {
    aud: over.aud ?? MCP_AUD,
    getIdentity: async () => (over.identity === null ? undefined : { email: OWNER, iat: NOW / 1000 - 60, user_uuid: "8b71e59e-0000-4000-8000-000000000000", ...over.identity }),
  };
}

function list(headers: Record<string, string> = {}, url = `https://${MCP_HOST}/mcp`): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

function setup() {
  const seen: CallerContext[] = [];
  const service = async (_input: unknown, caller: CallerContext): Promise<CodeToolOutput> => {
    seen.push(caller);
    return { status: "completed", result: 1, truncated: false, untrusted: true, report: REPORT };
  };
  const ask = (request: Request, ctx: AccessContext | undefined, env: Env = ENV) => mcpResponse(request, env, ctx, () => NOW, service);
  return { seen, ask };
}

describe("signing in to the MCP server (task 2.1.2, FR-25)", () => {
  it("serves the owner, signed in through the MCP address's own Access application", async () => {
    const { ask } = setup();
    const response = await ask(list(), access());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"code"');
  });

  it.each<[string, AccessContext | undefined]>([
    ["a request Access did not authenticate", undefined],
    ["a sign-in to the console, which is another Access application", access({ aud: CONSOLE_AUD })],
    ["a sign-in to some other application altogether", access({ aud: "x".repeat(64) })],
    ["another person", access({ identity: { email: "someone-else@example.test" } })],
    ["a service token", access({ identity: { service_token_id: "abc", email: undefined } })],
    ["an identity that cannot be read", access({ identity: null })],
  ])("refuses %s, and the tool is never reached", async (_label, ctx) => {
    const { ask, seen } = setup();
    const response = await ask(list(), ctx);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "sign_in_required" });
    expect(seen).toHaveLength(0);
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["the MCP audience is not set", { MCP_ACCESS_AUD: undefined }],
    ["the MCP audience is blank", { MCP_ACCESS_AUD: "  " }],
    ["the owner's address is not set", { OWNER_EMAIL: undefined }],
  ])("refuses everyone while %s", async (_label, change) => {
    const { ask } = setup();
    expect((await ask(list(), access(), { ...ENV, ...change } as Env)).status).toBe(401);
  });

  it("refuses a request from a web page, even with the owner signed in", async () => {
    const { ask, seen } = setup();
    const response = await ask(list({ origin: "https://evil.example" }), access());
    expect(response.status).toBe(403);
    expect((await ask(list({ origin: `https://${MCP_HOST}` }), access())).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("does not let a token the client sends, or anything else in the request, stand in for sign-in", async () => {
    const { ask } = setup();
    const forged = list({ authorization: "Bearer oauth:anything", "cf-access-jwt-assertion": "eyJ.forged.jwt", "cf-access-authenticated-user-email": OWNER });
    expect((await ask(forged, undefined)).status).toBe(401);
  });

  it("gives the tool the most cautious provider route, whatever the request says", async () => {
    const { ask, seen } = setup();
    const call = new Request(`https://${MCP_HOST}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "code", arguments: { script: "return 1;", project: "work" } } }),
    });
    expect((await ask(call, access())).status).toBe(200);
    expect(seen.map((caller) => caller.providerRoute)).toEqual(["unknown"]);
  });

  it("answers nothing else at the MCP address", async () => {
    const { ask } = setup();
    for (const path of ["/", "/health", "/console", "/console/state", "/mcp/extra"]) {
      expect((await ask(list({}, `https://${MCP_HOST}${path}`), access())).status, path).toBe(404);
    }
  });
});

describe("the two addresses kept apart (FR-49, FR-25)", () => {
  it("serves no console at the MCP address, even to the owner signed in to the console", async () => {
    const response = await handle(new Request(`https://${MCP_HOST}/console`), ENV, access({ aud: CONSOLE_AUD }), () => NOW);
    expect(response.status).toBe(404);
  });

  it("serves no MCP at the console's address, even to the owner signed in to the MCP application", async () => {
    const response = await handle(list({}, "https://console.execward.com/mcp"), ENV, access(), () => NOW);
    expect(response.status).toBe(404);
  });

  it("refuses the MCP address to everyone when Access did not authenticate the request", async () => {
    expect((await handle(list(), ENV, undefined, () => NOW)).status).toBe(401);
  });

  it("still answers the health check at the console's address", async () => {
    expect((await handle(new Request("https://console.execward.com/health"), ENV, undefined, () => NOW)).status).toBe(200);
  });
});
