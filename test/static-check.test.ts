import { describe, expect, it } from "vitest";
import { ADVERSARIAL_CASES, runSuite, stubTarget } from "../src/adversarial";
import type { ScriptRun, Target } from "../src/adversarial";
import { fakeToken } from "../src/adversarial/fixtures";
import { errorSchema } from "../src/contracts/errors";
import { SCRIPT_LIMITS } from "../src/limits";
import { checkScript } from "../src/static-check/check";

async function rules(script: string): Promise<string[]> {
  const result = await checkScript(script);
  return result.ok ? [] : result.problems.map((problem) => problem.rule);
}

async function messages(script: string): Promise<string[]> {
  const result = await checkScript(script);
  return result.ok ? [] : result.problems.map((problem) => problem.message);
}

describe("scripts the check accepts", () => {
  it.each([
    ["a tool call with top-level await and return", `const page = await tools.github_list_issues({ repo: "x" });\nreturn page.items.length;`],
    ["loops, closures and language built-ins", `const totals = new Map();\nfor (const n of [1, 2, 3]) totals.set(n, Math.max(n, 2));\nreturn JSON.stringify(Object.fromEntries(totals));`],
    ["search, describe, assert and console", `const found = await search("issues");\nconst docs = await describe("github_list_issues");\nassert(found, "nothing found");\nconsole.log(docs);\nreturn undefined;`],
    ["try and catch around a tool", `try { await tools.github_get_commit({ sha: "abc" }); } catch (error) { return String(error); }`],
    ["functions, classes and destructuring", `class Counter { constructor() { this.n = 0; } add() { this.n++; } }\nconst { items = [], ...rest } = await tools.x({});\nfunction size(list) { return list.length; }\nconst c = new Counter(); c.add();\nreturn [size(items), Object.keys(rest).length, c.n];`],
    ["parallel calls", `const pages = await Promise.all([1, 2].map((page) => tools.github_list_issues({ page })));\nreturn pages.flat().length;`],
    ["a local variable that shares a global's name", `const fetch = (x) => x;\nconst process = { env: {} };\nreturn fetch(process.env);`],
    ["dates, numbers and encoding", `return [new Date(0).toISOString(), parseInt("7", 10), encodeURIComponent("a b"), Number.isInteger(1)];`],
    ["an empty script", ``],
  ])("%s", async (_label, script) => {
    const result = await checkScript(script);
    expect(result.ok ? [] : result.problems).toEqual([]);
  });
});

describe("blocked constructs (FR-33)", () => {
  it.each([
    ["eval", `return eval("1 + 1");`, "eval is not allowed"],
    ["eval behind an alias", `const run = eval; return run("1");`, "eval is not allowed"],
    ["the Function constructor", `return new Function("return 1")();`, "the Function constructor is not allowed"],
    ["Function called without new", `return Function("return 1")();`, "the Function constructor is not allowed"],
    ["dynamic import", `const os = await import("node:os"); return os;`, "dynamic import is not allowed"],
    ["WebAssembly compilation", `await WebAssembly.compile(new Uint8Array([0]));`, "WebAssembly compilation is not allowed"],
    ["a static import", `import os from "node:os"; return os;`, "import and export statements are not allowed"],
    ["an export", `export const x = 1;`, "import and export statements are not allowed"],
    ["import.meta", `return import.meta.url;`, "import.meta and new.target are not allowed"],
    ["the constructor chain", `return tools.constructor.constructor("return 1")();`, "reading .constructor is not allowed"],
    ["the constructor through a string key", `return tools["constructor"];`, "reading .constructor is not allowed"],
    ["the constructor through a template key", "return tools[`constructor`];", "reading .constructor is not allowed"],
    ["the constructor through an async function", `return (async () => {}).constructor("return 1");`, "reading .constructor is not allowed"],
    ["the constructor through destructuring", `const { constructor: F } = tools; return F;`, 'a property named "constructor" is not allowed'],
  ])("refuses %s", async (_label, script, expected) => {
    const result = await checkScript(script);
    expect(result.ok).toBe(false);
    expect((await messages(script)).some((message) => message.startsWith(expected))).toBe(true);
    expect((await rules(script)).includes("blocked_construct")).toBe(true);
  });
});

describe("globals outside the Sandbox API (FR-33)", () => {
  it.each(["fetch", "process", "globalThis", "self", "require", "setTimeout", "Reflect", "Proxy", "XMLHttpRequest", "WebSocket", "caches", "navigator", "crypto", "arguments"])(
    "refuses %s",
    async (name) => {
      expect(await messages(`return typeof ${name};`)).toEqual([`"${name}" is not part of the Sandbox API`]);
    },
  );

  it("refuses a global used outside the block that declared a local of the same name", async () => {
    expect(await messages(`{ const fetch = 1; }\nreturn fetch("https://example.com");`)).toEqual(['"fetch" is not part of the Sandbox API']);
    expect(await messages(`function inner() { var process = {}; return process; }\nreturn process.env;`)).toEqual(['"process" is not part of the Sandbox API']);
  });

  it("refuses reassigning a Sandbox API name or a built-in", async () => {
    expect(await messages(`tools = {};`)).toEqual(['"tools" cannot be reassigned']);
    expect(await messages(`JSON = null;`)).toEqual(['"JSON" cannot be reassigned']);
  });

  it("refuses an assignment that would create a global", async () => {
    expect(await rules(`leaked = 1;`)).toEqual(["undeclared_global"]);
  });

  it("reports the line", async () => {
    const result = await checkScript(`const a = 1;\nconst b = 2;\nreturn fetch(a + b);`);
    expect(result.ok ? undefined : result.error.line).toBe(3);
  });
});

describe("size, syntax and secrets (FR-33)", () => {
  it("refuses a script over the size limit without parsing it", async () => {
    const result = await checkScript(`// ${"x".repeat(SCRIPT_LIMITS.maxScriptBytes)}`);
    expect(result.ok ? [] : result.problems.map((problem) => problem.rule)).toEqual(["size"]);
  });

  it("counts bytes, not characters", async () => {
    const script = `// ${"é".repeat(SCRIPT_LIMITS.maxScriptBytes / 2)}`;
    expect(script.length).toBeLessThan(SCRIPT_LIMITS.maxScriptBytes);
    expect(await rules(script)).toEqual(["size"]);
  });

  it("refuses a script that is not valid JavaScript, with the line", async () => {
    const result = await checkScript(`const a = 1;\nreturn a +;`);
    expect(result.ok ? undefined : result.problems[0]?.rule).toBe("parse");
    expect(result.ok ? undefined : result.error.line).toBe(2);
  });

  it("refuses a script that tries to close a wrapper around it", async () => {
    expect(await rules(`return 1; }); fetch("https://evil.example"); (async () => {`)).toEqual(["parse"]);
  });

  it("refuses syntax that reads differently outside a module", async () => {
    expect(await rules(`with (tools) { return github_list_issues({}); }`)).toEqual(["parse"]);
  });

  it("refuses a secret-shaped literal and never repeats it", async () => {
    const token = fakeToken();
    const result = await checkScript(`const a = 1;\nconst token = "${token}";\nreturn await tools.x({ token });`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([{ rule: "secret", message: "the script contains what looks like a GitHub token", line: 2 }]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    ["an AWS access key", ["AKIA", "ABCDEFGHIJKLMNOP"].join("")],
    ["an Anthropic API key", ["sk-ant", "-api03-", "a".repeat(24)].join("")],
    ["a Slack token", ["xoxb", "-1234567890-abcdefghij"].join("")],
    ["a private key", ["-----BEGIN RSA PRIVATE", " KEY-----"].join("")],
  ])("recognises %s by shape", async (name, value) => {
    expect(await messages(`const s = "${value}"; return s.length;`)).toEqual([`the script contains what looks like ${name}`]);
  });

  it("does not mistake ordinary text for a secret", async () => {
    expect(await rules(`return ["sk-short", "ghp_tooshort", "eyJ.notatoken", "risk-assessment-for-the-quarter"];`)).toEqual([]);
  });
});

describe("the result", () => {
  it("carries the SHA-256 of the script, whether it passes or not", async () => {
    const passed = await checkScript("return 1;");
    expect(passed.scriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await checkScript("return 1;")).scriptHash).toBe(passed.scriptHash);
    expect((await checkScript("return 2;")).scriptHash).not.toBe(passed.scriptHash);
    const failed = await checkScript("return eval('1');");
    expect(failed.scriptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 of an empty script", async () => {
    expect((await checkScript("")).scriptHash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("returns a contract error with the static_check_failed code", async () => {
    const result = await checkScript(`return eval("1") + fetch("x");`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(errorSchema.parse(result.error)).toEqual({ code: "static_check_failed", message: "eval is not allowed (and 1 more)", line: 1 });
  });
});

describe("against the adversarial suite (FR-31)", () => {
  /** The defenceless stub with only the static check put in front of it. */
  function checkedStub(): Target {
    const stub = stubTarget();
    return {
      ...stub,
      name: "stub behind the static check",
      async runScript(run: ScriptRun) {
        const result = await checkScript(run.script);
        if (!result.ok) return { status: "refused", errorCode: result.error.code, logs: [] };
        if (!stub.runScript) throw new Error("the stub has no runScript");
        return stub.runScript(run);
      },
    };
  }

  const STOPPED_BY_STATIC_CHECK = [
    "escape-host-environment",
    "escape-constructor-chain",
    "undeclared-global",
    "blocked-eval",
    "blocked-function-constructor",
    "blocked-dynamic-import",
    "blocked-webassembly",
    "oversized-script",
    "secret-literal-in-script",
  ];

  it("stops exactly the script-shaped attacks it is meant to, and still serves the controls", async () => {
    const results = await runSuite(checkedStub());
    const defended = results.filter((result) => result.kind === "attack" && result.defended).map((result) => result.id);
    expect(defended.sort()).toEqual([...STOPPED_BY_STATIC_CHECK].sort());
    const controls = results.filter((result) => result.kind === "control");
    expect(controls.every((result) => result.defended)).toBe(true);
  });

  it("names every case it claims to stop", () => {
    const ids = new Set(ADVERSARIAL_CASES.map((item) => item.id));
    for (const id of STOPPED_BY_STATIC_CHECK) expect(ids.has(id), id).toBe(true);
  });
});
