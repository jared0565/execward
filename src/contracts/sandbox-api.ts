/**
 * Contract 3: the Sandbox API. Everything a script can see, and nothing else.
 *
 *   tools.<server>_<tool>(args)   call a wrapped tool
 *   search(query)                 find tools without loading the catalog (FR-3)
 *   describe(path)                typed docs for one tool path (FR-3)
 *   assert(condition, message)    end the run when a condition is false (FR-40)
 *   console.log(...)              captured and returned as logs
 */

/** The names a script may reference. The static check refuses any other global (FR-33). */
export const SANDBOX_GLOBALS = ["tools", "search", "describe", "assert", "console"] as const;
export type SandboxGlobal = (typeof SANDBOX_GLOBALS)[number];

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
  readonly console: { log(...values: unknown[]): void };
}
