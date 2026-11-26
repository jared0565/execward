import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "../src/connectors/github";
import { ALLOWED_OUTBOUND_HOSTS, OutboundRefused, outboundFetch, outboundProblem } from "../src/net/outbound";

describe("the hosts the core may call (task 1.1.6, FR-24)", () => {
  it("lists the GitHub API and nothing else", () => {
    expect(ALLOWED_OUTBOUND_HOSTS).toEqual(["api.github.com"]);
    expect(new URL(GITHUB_API).hostname).toBe("api.github.com");
  });

  it("allows a plain HTTPS address on a listed host", () => {
    expect(outboundProblem("https://api.github.com/repos/a/b/issues?state=open")).toBeUndefined();
    expect(outboundProblem("https://API.GitHub.com/user")).toBeUndefined();
  });

  it.each([
    ["another host", "https://example.com/"],
    ["a host that only starts with a listed one", "https://api.github.com.example.com/"],
    ["a host that only ends with a listed one", "https://evil-api.github.com/"],
    ["a subdomain of a listed host", "https://x.api.github.com/"],
    ["plain HTTP", "http://api.github.com/"],
    ["another scheme", "ftp://api.github.com/"],
    ["a user name in the address", "https://api.github.com@example.com/"],
    ["a password in the address", "https://user:secret@api.github.com/"],
    ["another port", "https://api.github.com:8443/"],
    ["an IP address", "https://140.82.112.5/"],
    ["the local machine", "https://localhost/"],
    ["a cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["a trailing dot on the host", "https://api.github.com./"],
    ["something that is not an address", "api.github.com/user"],
    ["nothing", ""],
  ])("refuses %s", (_label, url) => {
    expect(outboundProblem(url)).toBeTypeOf("string");
  });

  it("does not repeat the address in its refusal, which could hold a secret", () => {
    expect(outboundProblem("https://user:hunter2@example.com/?key=abc")).not.toMatch(/hunter2|abc|example/);
  });

  it("sends an allowed request without following redirects, and sends nothing for a refused one", async () => {
    const sent: { url: string; redirect: unknown; method: unknown }[] = [];
    const inner = (async (url: string, init?: RequestInit) => {
      sent.push({ url, redirect: init?.redirect, method: init?.method });
      return new Response("ok");
    }) as typeof fetch;
    const guarded = outboundFetch(ALLOWED_OUTBOUND_HOSTS, inner);
    expect(await (await guarded("https://api.github.com/user", { method: "GET" })).text()).toBe("ok");
    // A caller cannot ask for redirects to be followed.
    await guarded("https://api.github.com/user", { redirect: "follow" } as never);
    await expect(guarded("https://example.com/")).rejects.toThrow(OutboundRefused);
    expect(sent).toEqual([
      { url: "https://api.github.com/user", redirect: "manual", method: "GET" },
      { url: "https://api.github.com/user", redirect: "manual", method: undefined },
    ]);
  });
});

/**
 * Whether a line of source reaches the network: the platform's fetch, a socket, or a module that brings its own.
 * A name inside a string or a comment is not a call: the static check lists these names in order to forbid them.
 */
function reachesTheNetwork(line: string): boolean {
  const code = line.replace(/\/\/.*$/, "");
  // Module names are looked for with the strings still in place.
  if (/["'](?:cloudflare:sockets|node:(?:http|https|http2|net|tls|dgram|dns)|openai|@anthropic-ai\/sdk|undici|node-fetch|axios)["']/.test(code) && /\b(?:import|from|require)\b/.test(code)) return true;
  const bare = code.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  return /(?<![\w.$])fetch\s*\(|\b(?:globalThis|self)\s*\.\s*fetch\b|\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\b|\bsendBeacon\s*\(/.test(bare);
}

/** Every source file the production Worker loads, found by following its imports from `src/worker.ts`. */
function loadedByTheWorker(): string[] {
  const seen = new Set<string>();
  const queue = [normalize("src/worker.ts")];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = join(dirname(file), match[1] as string);
      const found = [`${target}.ts`, join(target, "index.ts"), target].find((candidate) => existsSync(candidate) && candidate.endsWith(".ts"));
      if (found) queue.push(normalize(found));
    }
  }
  return [...seen].map((file) => file.replaceAll("\\", "/")).sort();
}

describe("the code the production Worker loads (task 1.1.6, FR-24)", () => {
  const files = loadedByTheWorker();

  it("was found by following imports, and includes the parts expected", () => {
    expect(files).toContain("src/worker.ts");
    expect(files).toContain("src/worker/scheduled.ts");
    expect(files).toContain("src/backup.ts");
    expect(files.length).toBeGreaterThan(8);
  });

  it("includes nothing from the eval harness or the test app, which do call model providers", () => {
    expect(files.filter((file) => file.startsWith("src/eval/") || file.startsWith("src/app/") || file.startsWith("src/adversarial/"))).toEqual([]);
  });

  it("opens no network connection except through the guarded fetch", () => {
    const found: string[] = [];
    for (const file of files) {
      if (file === "src/net/outbound.ts") continue;
      // The console page is text sent to the owner's browser. Its script runs there, not in the Worker (checked below).
      if (file === "src/console/page.ts") continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          // The Worker's own request handler is named `fetch`. It receives requests; it sends none.
          if (file === "src/worker.ts" && line.trim() === "async fetch(request: Request, env: Env, ctx: { readonly access?: AccessContext }): Promise<Response> {") return;
          // The MCP library's handler is also named `fetch`. The adapter hands it the request it was given; nothing is sent.
          if (file === "src/mcp/adapter.ts" && line.trim() === "return await handler.fetch(request);") return;
          if (reachesTheNetwork(line)) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(found).toEqual([]);
  });

  it("lets the console page's browser script call only the console's own addresses", () => {
    const page = readFileSync("src/console/page.ts", "utf8");
    const calls = [...page.matchAll(/fetch\(([^,)]*)/g)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const target of calls) expect(target).toMatch(/^"\/console\/(?:state|action|queue|projects|saving|stats)"$/);
    // Nothing else in it reaches out, and it imports nothing.
    expect(page).not.toMatch(/https?:\/\/|WebSocket|EventSource|XMLHttpRequest|sendBeacon|\bimport\b/);
  });

  it("would notice each way of reaching the network, were one added", () => {
    for (const line of [
      `const reply = await fetch("https://example.com");`,
      `  return fetch(url, init);`,
      `await globalThis.fetch(url);`,
      `const socket = new WebSocket(address);`,
      `import { connect } from "cloudflare:sockets";`,
      `import https from "node:https";`,
      `const net = await import("node:net");`,
      `import OpenAI from "openai";`,
      `navigator.sendBeacon(url, data);`,
    ]) {
      expect(reachesTheNetwork(line), line).toBe(true);
    }
    for (const line of [
      `response = await deps.fetch(url, { method: "GET" });`,
      `const BLOCKED = ["fetch", "WebSocket", "XMLHttpRequest"];`,
      `// a script must not call fetch(...)`,
      `readonly fetch: (url: string) => Promise<Response>;`,
      `message: "use the tools; fetch() is not available",`,
    ]) {
      expect(reachesTheNetwork(line), line).toBe(false);
    }
  });
});
