/**
 * The MCP adapter on the deployed test Worker (task 2.1.1): a real MCP client,
 * over the internet, to the real code tool with every store on the database and
 * the sandbox Cloudflare's own. The tools are the invented GitHub. Run with
 * `npm run test:deployed`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

const URL_BASE = setting("EXECWARD_TEST_URL", "test-worker-url");
const SECRET = setting("EXECWARD_TEST_SECRET", "test-worker-secret");
const AUTH = { authorization: `Bearer ${SECRET}` };

async function connect(headers: Record<string, string> = AUTH) {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "execward-deployed-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return client;
}

const text = (result: { content?: unknown }): string => ((result.content as { text: string }[] | undefined) ?? []).map((item) => item.text).join("\n");

describe("the MCP adapter on Cloudflare (task 2.1.1)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const setup = await fetch(`${URL_BASE}/service`, { method: "POST", headers: AUTH, body: JSON.stringify({ setup: true }) });
    if (!setup.ok) throw new Error(`the setup answered ${setup.status}`);
  });

  it("lists one tool, `code`", async () => {
    const client = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["code"]);
    await client.close();
  });

  it("runs a script that calls a tool, and returns the answer inside the untrusted block", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "code",
      arguments: { script: `const repo = await tools.github_get_repository({ owner: "northwind-labs", repo: "web-dashboard" });\nreturn repo.name;`, project: "eval" },
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("<untrusted_tool_output>");
    expect(text(result)).toContain("web-dashboard");
    await client.close();
  });

  it("keeps the tool list unchanged across a session that discovers tools through `search()` (task 2.1.3, FR-14)", async () => {
    const client = await connect();
    const before = JSON.stringify((await client.listTools()).tools);

    // The session discovers tools: first by search, then one tool's types, then it calls what it found.
    const found = await client.callTool({ name: "code", arguments: { script: `return await search("list issues");`, project: "eval" } });
    expect(found.isError).toBeFalsy();
    expect(text(found)).toContain("github_list_issues");
    expect(JSON.stringify((await client.listTools()).tools)).toBe(before);

    const described = await client.callTool({ name: "code", arguments: { script: `return await describe("github_list_issues");`, project: "eval" } });
    expect(described.isError).toBeFalsy();
    expect(JSON.stringify((await client.listTools()).tools)).toBe(before);

    const used = await client.callTool({
      name: "code",
      arguments: { script: `const issues = await tools.github_list_issues({ owner: "northwind-labs", repo: "web-dashboard" });\nreturn issues.length;`, project: "eval" },
    });
    expect(used.isError).toBeFalsy();

    // Still the one tool, word for word, and the server never said the list could change.
    const after = (await client.listTools()).tools;
    expect(after.map((tool) => tool.name)).toEqual(["code"]);
    expect(JSON.stringify(after)).toBe(before);
    expect(client.getServerCapabilities()?.tools?.listChanged ?? false).toBe(false);
    await client.close();
  });

  it("marks checks the model wrote as model-supplied, and returns the run report with the reply (task 2.1.5, FR-47, FR-39)", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "code",
      arguments: { script: `return 7;`, project: "eval", intent: "Return seven.", criteria: ["The result is the number seven."] },
    });
    expect(result.isError).toBeFalsy();
    const reply = JSON.parse(text(result).split("<untrusted_tool_output>")[1]?.split("</untrusted_tool_output>")[0] ?? "{}") as {
      result: unknown;
      report: { runId: string; criteria?: { source: string; items: string[] }; verification: string; callsByTool: object };
    };
    expect(reply.result).toBe(7);
    expect(reply.report.criteria).toEqual({ source: "model_supplied", items: ["The result is the number seven."] });
    // The report itself: which run, what it called, and that nobody independent checked it.
    expect(reply.report.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reply.report.callsByTool).toEqual({});
    expect(reply.report.verification).toBe("unreviewed");
    await client.close();
  });

  it("refuses the run after a third failure in a row, across separate requests, and leaves other projects alone (task 2.1.5, FR-41)", async () => {
    const failing = { script: `throw new Error("deliberate failure");`, project: "retry-limit" };
    // Each call is its own connection, as each stands alone for the server.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const client = await connect();
      const result = await client.callTool({ name: "code", arguments: failing });
      expect(result.isError, `attempt ${attempt}`).toBe(true);
      expect(text(result), `attempt ${attempt}`).toContain("script_error");
      await client.close();
    }
    // A script that would succeed is now refused before it runs.
    const client = await connect();
    const refused = await client.callTool({ name: "code", arguments: { script: `return 1;`, project: "retry-limit" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("quota_exceeded");
    expect(text(refused)).toContain("retry limit");
    // Another project is untouched.
    const other = await client.callTool({ name: "code", arguments: { script: `return 1;`, project: "eval" } });
    expect(other.isError).toBeFalsy();
    await client.close();
  });

  it("clears the count when a run completes (task 2.1.5)", async () => {
    const client = await connect();
    const fail = { script: `throw new Error("deliberate failure");`, project: "retry-clears" };
    await client.callTool({ name: "code", arguments: fail });
    await client.callTool({ name: "code", arguments: fail });
    expect((await client.callTool({ name: "code", arguments: { script: `return 1;`, project: "retry-clears" } })).isError).toBeFalsy();
    // Two more failures are again allowed to be followed by a try.
    await client.callTool({ name: "code", arguments: fail });
    await client.callTool({ name: "code", arguments: fail });
    expect((await client.callTool({ name: "code", arguments: { script: `return 1;`, project: "retry-clears" } })).isError).toBeFalsy();
    await client.close();
  });

  it("refuses a script the static check refuses, as an error result", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "code", arguments: { script: `return fetch("https://example.com");`, project: "eval" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("static_check_failed");
    await client.close();
  });

  it("gives a project it has no record of nothing above public data (FR-32)", async () => {
    // No record means the most cautious class. The same script that answers for "eval" must not answer here.
    const client = await connect();
    const result = await client.callTool({
      name: "code",
      arguments: { script: `const repo = await tools.github_get_repository({ owner: "northwind-labs", repo: "web-dashboard" });\nreturn repo.name;`, project: "no-such-project" },
    });
    expect(text(result)).not.toContain("web-dashboard");
    await client.close();
  });

  it("answers nobody without the test Worker's secret", async () => {
    const response = await fetch(`${URL_BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    expect(response.status).toBe(401);
  });
});
