/**
 * Runs the Dynamic Worker executor inside the local Workers runtime (workerd),
 * through the test-only Worker in ./workers/harness.ts.
 *
 * This is the local half of the evidence for task 1.2.1. The local runtime is
 * not a hardened sandbox, so these tests show the executor's own behaviour and
 * the isolate's configuration; the reach test on a deployed Worker is task 1.2.8.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { codeToolOutputSchema, type CodeToolOutput } from "../src/contracts/code-tool";
import type { ExecutionLimits, ExecutionOutcome } from "../src/executor";
import { LANGUAGE_BUILTINS, SANDBOX_GLOBALS } from "../src/contracts/sandbox-api";
import { record } from "./fixtures/policy";

interface Reply {
  readonly outcome: ExecutionOutcome;
  readonly calls: readonly { path: string; args: unknown }[];
}

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: "test/workers/wrangler.jsonc",
    dev: { server: { port: 0 }, inspector: false, logLevel: "error" },
  });
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
});

async function run(script: string, limits: Partial<ExecutionLimits> = {}, linger = false): Promise<Reply> {
  const response = await worker.fetch(`http://harness.invalid/${linger ? "?linger" : ""}`, {
    method: "POST",
    body: JSON.stringify({ script, limits }),
  });
  return (await response.json()) as Reply;
}

function failure(reply: Reply): { kind: string; message: string; line?: number } {
  if (reply.outcome.status !== "failed") throw new Error(`expected a failure, got ${JSON.stringify(reply.outcome)}`);
  return reply.outcome.failure;
}

describe("the Dynamic Worker executor, in the local Workers runtime", { timeout: 30_000 }, () => {
  it("runs a script, forwards its tool calls to the host and returns the final value", async () => {
    const reply = await run(`const a = await tools.test_echo({ n: 1 });\nconst b = await tools.test_echo({ n: 2 });\nreturn [a.args.n, b.args.n];`);
    expect(reply.outcome).toEqual({ status: "completed", result: [1, 2], logs: [], truncated: false, assertionsPassed: 0 });
    expect(reply.calls).toEqual([
      { path: "test_echo", args: { n: 1 } },
      { path: "test_echo", args: { n: 2 } },
    ]);
  });

  it("offers search, describe, assert and console", async () => {
    const reply = await run(`const found = await search("echo");\nconst docs = await describe(found[0]);\nassert(docs.description, "no description");\nconsole.log("found", found);\nreturn docs.path;`);
    expect(reply.outcome).toEqual({ status: "completed", result: "test_echo", logs: ['found ["test_echo"]'], truncated: false, assertionsPassed: 1 });
    expect(reply.calls.map((call) => call.path)).toEqual(["search", "describe"]);
  });

  it("returns null when the script returns nothing", async () => {
    expect((await run(`const a = 1;`)).outcome).toMatchObject({ status: "completed", result: null });
  });

  it("lets a script catch a tool error and carry on", async () => {
    const reply = await run(`try { await tools.test_fail({}); } catch (error) { return "caught: " + error.message; }`);
    expect(reply.outcome).toMatchObject({ status: "completed", result: "caught: upstream said no" });
  });

  it("reports a thrown error with the script's own line number", async () => {
    const reply = await run(`const a = 1;\nconst b = 2;\nthrow new Error("boom");`);
    expect(failure(reply)).toEqual({ kind: "script_error", message: "boom", line: 3 });
  });

  it("reports a failed assertion as its own kind, with the value and the line", async () => {
    const reply = await run(`const list = [];\nassert(list.length, "the list is empty");`);
    expect(failure(reply)).toEqual({ kind: "assertion_failed", message: "the list is empty (the condition was 0)", line: 2 });
  });

  it("counts the assertions that passed", async () => {
    const reply = await run(`assert(true);\nassert(1, "one");\nreturn "ok";`);
    expect(reply.outcome).toMatchObject({ status: "completed", result: "ok", assertionsPassed: 2 });
  });

  it("ends the run at a failed assertion, before the next call", async () => {
    const reply = await run(`await tools.test_echo({ step: 1 });\nassert(false, "stop here");\nawait tools.test_echo({ step: 2 });`);
    expect(failure(reply)).toMatchObject({ kind: "assertion_failed", line: 2 });
    expect(reply.calls).toEqual([{ path: "test_echo", args: { step: 1 } }]);
  });

  it("does not let a script catch a failed assertion and carry on", async () => {
    const reply = await run(
      `assert(true);\ntry { assert(null, "must exist"); } catch {}\n` +
        `try { await tools.test_echo({ after: true }); } catch {}\ntry { await search("x"); } catch {}\nreturn "carried on";`,
    );
    expect(reply.outcome).toMatchObject({
      status: "failed",
      failure: { kind: "assertion_failed", message: "must exist (the condition was null)", line: 2 },
      assertionsPassed: 1,
    });
    expect(reply.calls).toEqual([]);
  });

  it("leaves the script no globals beyond the allowed set", async () => {
    // Walks the prototype chain too: fetch and setTimeout are not the global object's own properties.
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
      result: {
        fetch: "undefined",
        process: "undefined",
        Buffer: "undefined",
        WebSocket: "undefined",
        caches: "undefined",
        setTimeout: "undefined",
        WebAssembly: "undefined",
        imported: "refused",
      },
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

  it("does not load a script that tries to close the wrapper around it", async () => {
    const reply = await run(`return 1; }\nexport const leaked = 1;\nasync function x() {`);
    expect(failure(reply)).toMatchObject({ kind: "script_error" });
    expect(failure(reply).message).toContain("not valid JavaScript");
  });

  it("does not load a script with an import statement", async () => {
    const reply = await run(`import os from "node:os";\nreturn 1;`);
    expect(failure(reply)).toEqual({ kind: "script_error", message: "import and export statements are not allowed", line: 1 });
  });

  it("stops forwarding calls at the run's limit, even when the script swallows the errors", async () => {
    const reply = await run(`for (let i = 0; i < 6; i++) { try { await tools.test_echo({ i }); } catch {} }\nreturn "finished anyway";`, { maxHostCalls: 2 });
    expect(failure(reply).kind).toBe("quota_exceeded");
    expect(reply.calls.length).toBe(2);
  });

  it("ends a run at its time limit and forwards nothing afterwards", async () => {
    const reply = await run(`await tools.test_slow({});\nawait tools.test_echo({ late: true });\nreturn "late";`, { wallClockMs: 60 }, true);
    expect(failure(reply)).toMatchObject({ kind: "timeout" });
    expect(reply.calls.map((call) => call.path)).toEqual(["test_slow"]);
  });

  it("cuts an oversized final value and says so", async () => {
    const reply = await run(`return "x".repeat(5000);`, { maxResultBytes: 100 });
    expect(reply.outcome).toMatchObject({ status: "completed", truncated: true });
    if (reply.outcome.status === "completed") expect(String(reply.outcome.result).length).toBeLessThanOrEqual(100);
  });

  it("keeps log output within the result budget", async () => {
    const reply = await run(`for (let i = 0; i < 50; i++) console.log("y".repeat(50));\nreturn 1;`, { maxResultBytes: 500 });
    expect(reply.outcome.logs.length).toBeLessThanOrEqual(11);
    expect(reply.outcome.logs.at(-1)).toBe("[further log output was dropped]");
  });

  it("reports a final value that cannot be written as JSON", async () => {
    const reply = await run(`const a = {}; a.self = a; return a;`);
    expect(failure(reply).kind).toBe("script_error");
  });
});

describe("the code tool end to end, in the local Workers runtime", { timeout: 30_000 }, () => {
  async function codeTool(input: unknown): Promise<{ output: CodeToolOutput; calls: readonly { path: string }[] }> {
    const response = await worker.fetch("http://harness.invalid/code-tool", { method: "POST", body: JSON.stringify(input) });
    const reply = (await response.json()) as { output: unknown; calls: { path: string }[] };
    return { output: codeToolOutputSchema.parse(reply.output), calls: reply.calls };
  }

  it("runs a script and returns a reply that matches the output contract", async () => {
    const { output, calls } = await codeTool({
      script: `const pages = await Promise.all([1, 2].map((page) => tools.test_echo({ page })));
console.log("pages", pages.length);
return pages.map((p) => p.args.page);`,
      project: "demo",
    });
    expect(output).toMatchObject({
      status: "completed",
      result: [1, 2],
      truncated: false,
      logs: ["pages 2"],
      report: { callsByTool: { test_echo: 2 }, errors: [] },
    });
    expect(calls.length).toBe(2);
  });

  it("refuses a script at the static check, inside the runtime, before any isolate is loaded", async () => {
    const { output, calls } = await codeTool({ script: `return (await fetch("https://example.com")).status;`, project: "demo" });
    expect(output).toMatchObject({ status: "refused", error: { code: "static_check_failed", message: '"fetch" is not part of the Sandbox API', line: 1 } });
    expect(calls).toEqual([]);
  });

  it("returns a script's own error with its line", async () => {
    const { output } = await codeTool({ script: `const a = await tools.test_echo({});
throw new TypeError("bad shape");`, project: "demo" });
    expect(output).toMatchObject({ status: "error", error: { code: "script_error", message: "bad shape", line: 2 }, report: { callsByTool: { test_echo: 1 } } });
  });

  it("reports a failed assertion with the condition's text and counts", async () => {
    const { output, calls } = await codeTool({
      script: `const page = await tools.test_echo({ n: 0 });\nassert(page.path, "has a path");\nassert(page.args.n > 0, "n must be positive");\nawait tools.test_echo({ n: 1 });`,
      project: "demo",
    });
    expect(output).toMatchObject({
      status: "error",
      error: {
        code: "assertion_failed",
        message: 'n must be positive (the condition was false); at line 3: assert(page.args.n > 0, "n must be positive");',
        line: 3,
      },
      report: { assertions: { passed: 1, failed: 1 }, callsByTool: { test_echo: 1 } },
    });
    expect(calls.length).toBe(1);
  });

  it("returns an oversized final value with the truncation notice", async () => {
    const { output } = await codeTool({ script: `return "x".repeat(100000);`, project: "demo" });
    expect(output).toMatchObject({ status: "completed", truncated: true });
    if (output.status === "completed") expect((output.result as { notice: string }).notice).toContain("Return less");
  });
});

describe("the policy table on a local D1 database", { timeout: 30_000 }, () => {
  type Read = { value?: unknown; error?: string };
  async function policy(body: unknown): Promise<{ got: Read; list: Read }> {
    const response = await worker.fetch("http://harness.invalid/policy", { method: "POST", body: JSON.stringify(body) });
    return (await response.json()) as { got: Read; list: Read };
  }

  it("stores and returns records, and returns nothing for a tool with no record", async () => {
    const records = [record("list_issues"), record("delete_repo", { callerRule: "direct", tier: 2 })];
    const found = await policy({ records, get: "github_delete_repo" });
    expect(found.got).toEqual({ value: records[1] });
    // Listed in path order.
    expect(found.list).toEqual({ value: [records[1], records[0]] });
    expect((await policy({ records, get: "github_unknown" })).got).toEqual({ value: null });
  });

  it("replaces a record written twice", async () => {
    const found = await policy({ records: [record("list_issues"), record("list_issues", { tier: 2 })], get: "github_list_issues" });
    expect(found.got).toMatchObject({ value: { tier: 2 } });
  });

  it.each([
    ["is not JSON", "{oops"],
    ["does not match the contract", JSON.stringify({ ...record("list_issues"), tier: 9 })],
    ["has an unknown field", JSON.stringify({ ...record("list_issues"), callerRule: "both", note: "trust me" })],
    ["is for a different tool", JSON.stringify(record("delete_repo", { callerRule: "both", tier: 0 }))],
  ])("refuses to read a stored row that %s", async (_label, raw) => {
    const found = await policy({ rawRows: [{ path: "github_list_issues", record: raw }], get: "github_list_issues" });
    expect(found.got.error).toContain("PolicyStoreError");
    expect(found.list.error).toContain("PolicyStoreError");
  });

  it("reports a missing table as a store error, not as an empty policy", async () => {
    const found = await policy({ noTable: true, get: "github_list_issues" });
    expect(found.got.error).toContain("PolicyStoreError: the policy table could not be read");
  });
});

describe("the whole stack: code tool, Dynamic Worker, broker and policy table", { timeout: 30_000 }, () => {
  const records = [record("list_issues"), record("delete_repo", { callerRule: "direct", tier: 2 }), record("create_issue", { tier: 1 })];
  async function brokered(script: string, table: object = { records }): Promise<{ output: CodeToolOutput; calls: readonly { path: string }[] }> {
    const response = await worker.fetch("http://harness.invalid/brokered", {
      method: "POST",
      body: JSON.stringify({ ...table, input: { script, project: "demo" } }),
    });
    const reply = (await response.json()) as { output: unknown; calls: { path: string }[] };
    return { output: codeToolOutputSchema.parse(reply.output), calls: reply.calls };
  }

  it("lets a script find and call a tool the policy allows", async () => {
    const { output, calls } = await brokered(`const [path] = await search("list");\nconst page = await tools[path]({ page: 1 });\nreturn page.from;`);
    expect(output).toMatchObject({ status: "completed", result: "list_issues", report: { callsByTool: { github_list_issues: 1 } } });
    expect(calls).toEqual([{ path: "github/list_issues", args: { page: 1 } }]);
  });

  it.each([
    ["a direct-only tool", "github_delete_repo", "may only be called directly"],
    ["a tool with no record", "github_transfer_repo", "has no policy record"],
    ["a tier-1 tool", "github_create_issue", "tier 1 tools"],
  ])("ends the run with policy_denied when a script calls %s, even if it catches the error", async (_label, path, reason) => {
    const { output, calls } = await brokered(
      `await tools.github_list_issues({});\ntry { await tools.${path}({}); } catch (error) { console.log("caught", error.message); }\n` +
        `await tools.github_list_issues({}).catch(() => {});\nreturn "carried on";`,
    );
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied" } });
    if (output.status === "error") expect(output.error.message).toContain(reason);
    expect(JSON.stringify(output)).not.toContain("carried on");
    expect(calls.length).toBe(1);
  });

  const FILES = {
    records: [record("get_file", { pathAllowlist: ["docs/"] })],
    inputSchema: { type: "object", properties: { path: { type: "string", format: "path" } }, required: ["path"] },
  };

  it("lets a script catch a schema error, fix its arguments and carry on", async () => {
    const { output, calls } = await brokered(
      `let note;\ntry { await tools.github_get_file({ path: 7, debug: true }); } catch (error) { note = error.message; }\n` +
        `const file = await tools.github_get_file({ path: "docs/a.md" });\nreturn { note, from: file.from };`,
      FILES,
    );
    expect(output).toMatchObject({ status: "completed", result: { from: "get_file" } });
    if (output.status === "completed") expect((output.result as { note: string }).note).toContain("schema_invalid: path: expected string, got integer");
    expect(calls).toEqual([{ path: "github/get_file", args: { path: "docs/a.md" } }]);
  });

  it("ends the run when a script reaches for a path off the allowlist", async () => {
    const { output, calls } = await brokered(`try { return await tools.github_get_file({ path: "docs/../.env" }); } catch { return "hidden"; }`, FILES);
    expect(output).toMatchObject({
      status: "error",
      error: { code: "policy_denied", message: 'the call to "github_get_file" was refused: the path in "path" is not on the tool\'s allowlist' },
    });
    expect(calls).toEqual([]);
  });

  it("denies every call when the policy table is missing", async () => {
    const { output, calls } = await brokered(`return await tools.github_list_issues({});`, { noTable: true });
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied", message: 'the call to "github_list_issues" was refused: the policy table is unavailable' } });
    expect(calls).toEqual([]);
  });
});
