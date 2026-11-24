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
