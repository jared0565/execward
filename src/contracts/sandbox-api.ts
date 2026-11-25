/**
 * Contract 3: the Sandbox API. Everything a script can see, and nothing else.
 *
 *   tools.<server>_<tool>(args)   call a wrapped tool
 *   search(query)                 find tools without loading the catalog (FR-3)
 *   describe(path)                typed docs for one tool path (FR-3)
 *   assert(condition, message)    end the run when a condition is false (FR-40)
 *   critical(name, value, basis)  declare a critical figure for the cross-check (FR-43)
 *   console.log(...)              captured and returned as logs
 */

/** The names ExecWard gives a script. */
export const SANDBOX_GLOBALS = ["tools", "search", "describe", "assert", "critical", "console"] as const;
export type SandboxGlobal = (typeof SANDBOX_GLOBALS)[number];

/**
 * Parts of the JavaScript language itself that a script may also reference
 * (added in contract 1.1.0). Each is pure computation: none reaches the
 * network, the host, the clock beyond reading it, or turns text into code.
 * The static check refuses every global that is in neither list (FR-33), so
 * `fetch`, `process`, `globalThis`, `eval`, `Function`, `WebAssembly`,
 * `Reflect` and `Proxy` are all refused.
 */
export const LANGUAGE_BUILTINS = [
  "undefined",
  "NaN",
  "Infinity",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "Intl",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "structuredClone",
] as const;
export type LanguageBuiltin = (typeof LANGUAGE_BUILTINS)[number];

/** Constructs the static check refuses outright (FR-33). */
export const BLOCKED_CONSTRUCTS = [
  "eval",
  "Function constructor",
  "dynamic import",
  "WebAssembly compilation",
] as const;

function clean(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Turns a server and tool name into the function name a script calls (FR-2):
 * `my-server` + `list-items` becomes `my_server_list_items`.
 */
export function toolPath(server: string, tool: string): string {
  const serverPart = clean(server);
  const toolPart = clean(tool);
  const path = `${serverPart}_${toolPart}`;
  if (serverPart === "" || toolPart === "" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(path)) {
    throw new Error(`cannot derive a tool path from "${server}" and "${tool}"`);
  }
  return path;
}

/** The typed shape of the script's global scope. Generated typings extend `tools`. */
export interface SandboxScope {
  readonly tools: Readonly<Record<string, (args?: unknown) => Promise<unknown>>>;
  search(query: string): Promise<unknown>;
  describe(path: string): Promise<unknown>;
  assert(condition: unknown, message?: string): asserts condition;
  /** Returns `value`. The host works the figure out again from `rows` after the run. */
  critical(name: string, value: number, basis: { readonly op: "sum" | "count" | "min" | "max" | "average"; readonly rows: readonly number[] }): number;
  readonly console: { log(...values: unknown[]): void };
}
