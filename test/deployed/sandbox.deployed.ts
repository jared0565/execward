/**
 * The cases that only mean something on Cloudflare itself (tasks 1.2.2, 1.2.8):
 * the local runtime does not enforce isolation limits. They run against the
 * deployed test Worker (test/workers/deployed.ts), not in `npm test`:
 *
 *   npm run test:deployed
 *
 * The address and the test secret come from EXECWARD_TEST_URL and
 * EXECWARD_TEST_SECRET, or from the files test-worker-url and
 * test-worker-secret in the folder .execward in the home folder. Neither is in
 * the repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGE_BUILTINS, SANDBOX_GLOBALS } from "../../src/contracts/sandbox-api";
import type { ExecutionLimits, ExecutionOutcome } from "../../src/executor";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

const URL_BASE = setting("EXECWARD_TEST_URL", "test-worker-url");
const SECRET = setting("EXECWARD_TEST_SECRET", "test-worker-secret");

interface Reply {
  readonly outcome: ExecutionOutcome;
  readonly calls: readonly { path: string; args: unknown }[];
}

async function post(route: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }): Promise<Response> {
  return fetch(`${URL_BASE}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function run(script: string, limits: Partial<ExecutionLimits> = {}, linger = false): Promise<Reply> {
  const response = await post(linger ? "/?linger" : "/", { script, limits });
  if (!response.ok) throw new Error(`the test Worker answered ${response.status}`);
  return (await response.json()) as Reply;
}

function failure(reply: Reply): { kind: string; message: string; line?: number } {
  if (reply.outcome.status !== "failed") throw new Error(`expected a failure, got ${JSON.stringify(reply.outcome).slice(0, 300)}`);
  return reply.outcome.failure;
}

describe("the deployed test Worker's own gate", { timeout: 30_000 }, () => {
  it("refuses a request with no secret, and one with the wrong secret", async () => {
    expect((await post("/", { script: "return 1;" }, {})).status).toBe(401);
    expect((await post("/", { script: "return 1;" }, { authorization: `Bearer ${"x".repeat(64)}` })).status).toBe(401);
    expect((await post("/code-tool", { script: "return 1;", project: "work" }, {})).status).toBe(401);
  });
});

describe("the sandbox on Cloudflare: limits (FR-4)", { timeout: 60_000 }, () => {
  it("runs a script and forwards its tool call", async () => {
    const reply = await run(`const echoed = await tools.test_echo({ a: 1 });\nreturn echoed.args.a + 1;`);
    expect(reply.outcome).toMatchObject({ status: "completed", result: 2 });
    expect(reply.calls).toEqual([{ path: "test_echo", args: { a: 1 } }]);
  });

  it("ends a script that spins the processor, as a timeout", async () => {
    const reply = await run(`let n = 0;\nwhile (true) { n++; }`, { cpuMs: 50, wallClockMs: 20_000 });
    expect(failure(reply)).toEqual({ kind: "timeout", message: "the run used more than its 50 ms of CPU time" });
    expect(reply.calls).toEqual([]);
  });

  it("ends a script that takes too much memory, as a quota", async () => {
    const reply = await run(`const keep = [];\nwhile (true) { keep.push(new Array(1e6).fill(keep.length)); }`, { cpuMs: 10_000, wallClockMs: 20_000 });
    expect(failure(reply)).toEqual({ kind: "quota_exceeded", message: "the run used more memory than the sandbox allows" });
  });

  it("ends a run that waits past its time limit, and forwards nothing afterwards", async () => {
    const reply = await run(`await tools.test_slow({});\nawait tools.test_echo({ late: true });\nreturn "late";`, { wallClockMs: 60 }, true);
    expect(failure(reply)).toMatchObject({ kind: "timeout" });
    expect(reply.calls.map((call) => call.path)).toEqual(["test_slow"]);
  });

  it("stops forwarding calls at the run's limit, even when the script swallows the errors", async () => {
    const reply = await run(`for (let i = 0; i < 6; i++) { try { await tools.test_echo({ i }); } catch {} }\nreturn "finished anyway";`, { maxHostCalls: 2 });
    expect(failure(reply).kind).toBe("quota_exceeded");
    expect(reply.calls.length).toBe(2);
  });

  it("still runs the next script after one was ended for CPU or memory", async () => {
    await run(`while (true) {}`, { cpuMs: 50, wallClockMs: 20_000 });
    expect((await run(`return "fine";`)).outcome).toMatchObject({ status: "completed", result: "fine" });
  });
});

describe("the sandbox on Cloudflare: escape and blocked constructs (FR-31, FR-33)", { timeout: 60_000 }, () => {
  it("leaves the script no globals beyond the allowed set", async () => {
    const reply = await run(
      `const names = new Set();\n` +
        `for (let level = globalThis; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {\n` +
        `  for (const name of Object.getOwnPropertyNames(level)) names.add(name);\n}\n` +
        `return [...names].filter((name) => name !== "constructor" && globalThis[name] !== undefined);`,
    );
    if (reply.outcome.status !== "completed") throw new Error(JSON.stringify(reply.outcome));
    const allowed = new Set<string>([...SANDBOX_GLOBALS, ...LANGUAGE_BUILTINS, "globalThis", "self", "Function", "Proxy", "Reflect", "Uint8Array", "ArrayBuffer"]);
    expect((reply.outcome.result as string[]).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("leaves nothing to read back from the global object's prototypes", async () => {
    const reply = await run(
      `const found = [];\n` +
        `for (let level = Object.getPrototypeOf(globalThis); level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {\n` +
        `  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(level))) {\n` +
        `    if (name !== "constructor" && (d.get || d.value !== undefined)) found.push(name);\n  }\n}\n` +
        `return found;`,
    );
    if (reply.outcome.status !== "completed") throw new Error(JSON.stringify(reply.outcome));
    const allowed = new Set<string>(LANGUAGE_BUILTINS);
    expect((reply.outcome.result as string[]).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("has no network, no environment values and no Node.js layer", async () => {
    const reply = await run(
      `let imported;\ntry { await import("node:os"); imported = "imported"; } catch (error) { imported = "refused"; }\n` +
        `return { fetch: typeof fetch, process: typeof process, Buffer: typeof Buffer, WebSocket: typeof WebSocket, caches: typeof caches, setTimeout: typeof setTimeout, WebAssembly: typeof WebAssembly, imported };`,
    );
    expect(reply.outcome).toMatchObject({
      status: "completed",
      result: { fetch: "undefined", process: "undefined", Buffer: "undefined", WebSocket: "undefined", caches: "undefined", setTimeout: "undefined", WebAssembly: "undefined", imported: "refused" },
    });
  });

  it("refuses to turn text into code, by any route", async () => {
    const routes = [
      `return (async () => {}).constructor("return 1")();`,
      `return tools.constructor.constructor("return 1")();`,
      `return new Function("return 1")();`,
      `return globalThis["ev" + "al"]("1");`,
    ];
    for (const script of routes) {
      const reply = await run(script);
      expect(failure(reply).kind, script).toBe("script_error");
      expect(reply.calls, script).toEqual([]);
    }
  });

  it("does not load a script that closes the wrapper around it, or one with an import", async () => {
    expect(failure(await run(`return 1; }\nexport const leaked = 1;\nasync function x() {`))).toMatchObject({ kind: "script_error" });
    expect(failure(await run(`import os from "node:os";\nreturn 1;`))).toEqual({ kind: "script_error", message: "import and export statements are not allowed", line: 1 });
  });

  it("refuses a reaching script at the static check, before any isolate is loaded", async () => {
    const response = await post("/code-tool", { script: `return fetch("https://example.com");`, project: "work" });
    const { output, calls } = (await response.json()) as { output: { status: string; error?: { code: string } }; calls: unknown[] };
    expect(output).toMatchObject({ status: "refused", error: { code: "static_check_failed" } });
    expect(calls).toEqual([]);
  });
});

describe("the stores on a deployed D1 database (FR-27)", { timeout: 60_000 }, () => {
  type Op = [store: string, op: string, ...args: unknown[]];
  async function stores(ops: readonly Op[]): Promise<{ results: ({ value: unknown } | { error: string })[]; counters: { id: string; total: number }[] }> {
    const response = await post("/stores", { ops: ops.map(([store, op, ...args]) => ({ store, op, args })), together: true });
    if (!response.ok) throw new Error(`the test Worker answered ${response.status}`);
    return (await response.json()) as never;
  }
  const values = (reply: Awaited<ReturnType<typeof stores>>): unknown[] => reply.results.map((result) => ("value" in result ? result.value : `error: ${result.error}`));
  const T = 1_800_000_000_000;

  it("loses no count when twenty adds arrive at once", async () => {
    const reply = await stores(Array.from({ length: 20 }, (): Op => ["quota", "add", "runs:work", 60_000, 1, T]));
    expect((values(reply) as number[]).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    expect(reply.counters).toMatchObject([{ total: 20 }]);
  });

  it("never gives out more slots than the limit when ten runs ask at once", async () => {
    const reply = await stores(Array.from({ length: 10 }, (_, n): Op => ["quota", "acquire", "running:work", `run-${n}`, 3, 60_000, T]));
    expect(values(reply).filter((taken) => taken === true).length).toBe(3);
  });

  it("lets exactly one of five switch changes win when all start from the same read", async () => {
    const state = { codeMode: true, killed: false, pausedProjects: [], blockedTools: [], version: 1 };
    const reply = await stores(Array.from({ length: 5 }, (_, n): Op => ["control", "write", { ...state, pausedProjects: [`project-${n}`] }, 0]));
    expect(values(reply).filter((won) => won === true).length).toBe(1);
  });
});
