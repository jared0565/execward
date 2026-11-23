/**
 * Builds the two JavaScript modules a Dynamic Worker is loaded with (task 1.2.1):
 * the script, wrapped as a function body, and the runner that calls it.
 *
 * Runs in the host. Nothing here executes the script.
 */
import { parse } from "acorn";
import { LANGUAGE_BUILTINS, SANDBOX_GLOBALS } from "../contracts/sandbox-api";

export const RUNNER_MODULE = "runner.js";
export const SCRIPT_MODULE = "script.js";

/** Lines the wrapper puts before the script, so a stack line can be mapped back (FR-7). */
export const SCRIPT_LINE_OFFSET = 1;

/**
 * Globals the runtime itself needs to stay in place, on top of what a script
 * may use. Everything else is removed from the isolate before the script runs.
 */
const RUNTIME_KEEPS = ["globalThis", "self", "Function", "Proxy", "Reflect", "Uint8Array", "ArrayBuffer"] as const;

export type SandboxModules =
  | { readonly ok: true; readonly modules: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string; readonly line?: number };

/**
 * The script goes into a function body by text. That is only safe if the text
 * is a complete list of statements on its own, so it cannot close the function
 * and carry on outside it. This parses it to make sure, whether or not the
 * static check (FR-33) ran first.
 */
export function buildSandboxModules(script: string): SandboxModules {
  let program: { body: { type: string; loc?: { start: { line: number } } }[] };
  try {
    program = parse(script, {
      ecmaVersion: 2024,
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowHashBang: false,
      locations: true,
    }) as unknown as typeof program;
  } catch (error) {
    const line = (error as { loc?: { line?: unknown } }).loc?.line;
    const reason = error instanceof Error ? error.message.replace(/\s*\(\d+:\d+\)$/, "") : "unknown error";
    return { ok: false, message: `the script is not valid JavaScript: ${reason}`, ...(typeof line === "number" ? { line } : {}) };
  }
  // Valid at the top of a module, but not inside the function body the script runs in.
  const moduleOnly = program.body.find((node) => node.type.startsWith("Import") || node.type.startsWith("Export"));
  if (moduleOnly) {
    return {
      ok: false,
      message: "import and export statements are not allowed",
      ...(moduleOnly.loc ? { line: moduleOnly.loc.start.line } : {}),
    };
  }

  return {
    ok: true,
    modules: {
      // SCRIPT_LINE_OFFSET counts the one line before the script here.
      [SCRIPT_MODULE]: `export default async function (tools, search, describe, assert, console) {\n${script}\n}\n`,
      [RUNNER_MODULE]: RUNNER_SOURCE,
    },
  };
}

const KEEP = JSON.stringify([...SANDBOX_GLOBALS, ...LANGUAGE_BUILTINS, ...RUNTIME_KEEPS]);

/**
 * Runs inside the Dynamic Worker. Plain JavaScript: there is no build step
 * between this string and the isolate.
 *
 * It strips the isolate's globals down to the allowed set, hands the script
 * the Sandbox API, and reports the outcome as data. The host treats that
 * report as untrusted.
 */
const RUNNER_SOURCE = `import { WorkerEntrypoint } from "cloudflare:workers";
import script from "./${SCRIPT_MODULE}";

const KEEP = new Set(${KEEP});

class AssertionFailure extends Error {}

function format(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function lineOf(error) {
  const match = /${SCRIPT_MODULE.replace(".", "\\.")}:(\\d+):\\d+/.exec(String((error && error.stack) || ""));
  return match ? Number(match[1]) - ${SCRIPT_LINE_OFFSET} : undefined;
}

// Remove every global the script has no business with. The isolate is used for
// one run only, so nothing else depends on them.
// Many of them (fetch, setTimeout, WebSocket) live on the global object's
// prototypes, not on the object itself, so the whole chain is walked and each
// name is hidden behind a fixed, empty property on the global object.
function stripGlobals() {
  const names = new Set();
  for (let level = globalThis; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const name of Object.getOwnPropertyNames(level)) {
      names.add(name);
      // Remove it from the prototype as well, or the script could read it back from there.
      if (level !== globalThis && !KEEP.has(name) && name !== "constructor") {
        try { delete level[name]; } catch {}
      }
    }
  }
  const left = [];
  for (const name of names) {
    if (KEEP.has(name) || name === "constructor") continue;
    try { delete globalThis[name]; } catch {}
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
    if (globalThis[name] !== undefined) left.push(name);
  }
  return left;
}

export class Code extends WorkerEntrypoint {
  async run(host) {
    const logs = [];
    const console = Object.freeze({
      log: (...values) => { logs.push(values.map(format).join(" ")); },
    });
    // The first failed assertion. Once set the run is over: no further call
    // leaves the sandbox, even if the script catches the error and carries on (FR-40).
    let failedAssertion;
    let assertionsPassed = 0;
    const open = () => { if (failedAssertion) throw failedAssertion.error; };
    // Every tool path is server_tool: letters, digits and underscores, with an underscore
    // inside. A name of any other shape (toString, then, toJSON, constructor) cannot be a
    // tool, so it is simply absent: printing or awaiting the tools object is a slip, not a
    // call. A name of the right shape that is not approved still reaches the broker, which
    // ends the run. (Owner's decision, 2026-11-23.)
    const toolShaped = (path) => typeof path === "string" && path.length <= 200 && path.includes("_") && !path.startsWith("_") && !path.endsWith("_") && [...path].every((c) => c === "_" || (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) && !(path[0] >= "0" && path[0] <= "9");
    const tools = new Proxy(Object.freeze({}), {
      get: (_target, path) => (toolShaped(path) ? (args) => { open(); return host.callTool(path, args); } : undefined),
    });
    const search = (query) => { open(); return host.search(query); };
    const describe = (path) => { open(); return host.describe(path); };
    const assert = (condition, message) => {
      if (condition) { assertionsPassed++; return; }
      const error = new AssertionFailure(message === undefined ? "assertion failed" : String(message));
      if (!failedAssertion) failedAssertion = { error, value: format(condition).slice(0, 200) };
      throw error;
    };
    const assertionReport = () => ({
      status: "failed",
      kind: "assertion_failed",
      message: String(failedAssertion.error.message),
      value: failedAssertion.value,
      line: lineOf(failedAssertion.error),
      assertionsPassed,
      logs,
      globalsLeft,
    });
    const globalsLeft = stripGlobals();
    try {
      const value = await script(tools, search, describe, assert, console);
      // A script that caught its own failed assertion still failed it.
      if (failedAssertion) return assertionReport();
      let resultJson;
      try {
        resultJson = JSON.stringify(value === undefined ? null : value);
      } catch (error) {
        return { status: "failed", kind: "script_error", message: "the final value cannot be written as JSON: " + String(error && error.message), assertionsPassed, logs, globalsLeft };
      }
      return { status: "completed", resultJson: resultJson === undefined ? "null" : resultJson, assertionsPassed, logs, globalsLeft };
    } catch (error) {
      if (failedAssertion) return assertionReport();
      return {
        status: "failed",
        kind: "script_error",
        message: String((error && error.message) || error),
        line: lineOf(error),
        assertionsPassed,
        logs,
        globalsLeft,
      };
    }
  }
}
`;
