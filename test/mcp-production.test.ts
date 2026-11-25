import { describe, expect, it } from "vitest";
import type { AccessContext } from "../src/console/access";
import type { CodeToolOutput } from "../src/contracts/code-tool";
import type { PolicyRecord } from "../src/contracts/policy";
import { callerLabels, MCP_HOST, mcpResponse } from "../src/mcp/production";
import { memoryMeterSink, meter } from "../src/meter/meter";
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

describe("direct tools for Claude Haiku on production (task 2.1.9)", () => {
  const record = (tool: string, dataClass: "internal" | "confidential"): PolicyRecord => ({
    server: "github",
    tool,
    definitionHash: "0".repeat(64),
    callerRule: "both",
    dataClass,
    tier: 0,
    sensitive: dataClass === "confidential",
    outbound: false,
    destinationAllowlist: [],
    quotas: {},
  });
  const RECORDS = [record("get_repository", "internal"), record("list_branches", "internal"), record("list_issues", "internal"), record("get_file_contents", "confidential"), record("search_code", "confidential")];
  const names = async (headers: Record<string, string>, records: () => Promise<readonly PolicyRecord[]> = async () => RECORDS): Promise<string[]> => {
    const service = async (): Promise<CodeToolOutput> => ({ status: "completed", result: 1, truncated: false, untrusted: true, report: REPORT });
    const response = await mcpResponse(list(headers), ENV, access(), () => NOW, service, undefined, records);
    const text = await response.text();
    const json = text.includes("data:") ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("") : text;
    return (JSON.parse(json) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
  };

  it("lists the looking-around tools at or below the caller's level when the client says it runs Claude Haiku", async () => {
    // The route is unknown, so the ceiling is internal: the tools that read file contents are not listed.
    expect(await names({ "x-execward-model": "claude-haiku-5-5" })).toEqual(["code", "github_get_repository", "github_list_branches"]);
  });

  it("lists only `code` for any other model, and for a client that names none", async () => {
    expect(await names({ "x-execward-model": "claude-fable-5-2" })).toEqual(["code"]);
    expect(await names({ "x-execward-model": "gpt-6-luna" })).toEqual(["code"]);
    expect(await names({})).toEqual(["code"]);
  });

  it("lists only `code` when the policy table cannot be read", async () => {
    expect(
      await names({ "x-execward-model": "claude-haiku-5-5" }, async () => {
        throw new Error("the database is away");
      }),
    ).toEqual(["code"]);
  });

  it("lists nothing the owner has not approved", async () => {
    expect(await names({ "x-execward-model": "claude-haiku-5-5" }, async () => [])).toEqual(["code"]);
  });

  it("does not sign anyone in: a Haiku header without Access is still refused", async () => {
    const response = await mcpResponse(list({ "x-execward-model": "claude-haiku-5-5" }), ENV, undefined, () => NOW, undefined, undefined, async () => RECORDS);
    expect(response.status).toBe(401);
  });
});

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

describe("what a CLI says about itself, for reports (task 2.1.6)", () => {
  const labels = (headers: Record<string, string>) => callerLabels(new Request(`https://${MCP_HOST}/mcp`, { headers }));

  it("takes the model name from the header each CLI's config sets", () => {
    expect(labels({ "x-execward-model": "claude-sonnet-5-5", "user-agent": "claude-code/2.1.330 (cli)" })).toEqual({ model: "claude-sonnet-5-5", client: "claude-code" });
    expect(labels({ "x-execward-model": "gpt-5.5-codex", "x-execward-client": "codex" })).toEqual({ model: "gpt-5.5-codex", client: "codex" });
    expect(labels({ "x-execward-model": "openrouter/anthropic/claude-haiku-5-5:free" }).model).toBe("openrouter/anthropic/claude-haiku-5-5:free");
  });

  it("gives no label when the CLI says nothing", () => {
    expect(labels({})).toEqual({});
  });

  it.each(["", "   ", "a model with spaces", "x".repeat(81), '"}],"injected":true', "-starts-with-a-dash", "tab\there"])("drops the value %j: it is not a plain short name", (value) => {
    expect(labels({ "x-execward-model": value }).model).toBeUndefined();
  });

  it("lets a label reach a report line, where runs are grouped by it", async () => {
    const sink = memoryMeterSink();
    const metering = meter({ sink, labels: labels({ "x-execward-model": "claude-sonnet-5-5", "x-execward-client": "claude-code" }) });
    await metering.start({ runId: "run-1", project: "acme" }).finish({ script: "return 1;", returned: 1 });
    expect(sink.records[0]?.labels).toEqual({ model: "claude-sonnet-5-5", client: "claude-code" });
  });

  it("decides nothing: a model name does not sign anyone in or change what a caller may read", async () => {
    const { ask, seen } = setup();
    const claimed = { "x-execward-model": "claude-opus-5-5", "x-execward-client": "trusted-enterprise-client" };
    expect((await ask(list(claimed), undefined)).status).toBe(401);
    const call = new Request(`https://${MCP_HOST}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...claimed },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "code", arguments: { script: "return 1;", project: "work" } } }),
    });
    await ask(call, access());
    expect(seen.map((caller) => caller.providerRoute)).toEqual(["unknown"]);
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
