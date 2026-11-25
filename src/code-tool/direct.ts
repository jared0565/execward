/**
 * Wrapped tools offered for calling directly, beside the `code` tool (task 2.1.9).
 *
 * The project owner chose this on 2026-11-24 as the guard for Claude Haiku: it
 * passes exploratory tasks with ordinary tool calls and gave up on one when each
 * step of looking cost a script.
 *
 * A direct call is not a second way in. It is turned into a one-line script and
 * run by the `code` tool, so every control of a script applies to it: policy,
 * data class, quotas, the release gate, the audit log and the retry limit.
 */
import { isAbove } from "../broker/exposure";
import type { DataClass } from "../contracts/policy";
import { toolPath } from "../contracts/sandbox-api";

/** Added to the `code` tool's description when the wrapped tools are listed beside it. */
export const BOTH_DOORS_GUIDANCE =
  "A few tools for looking around are also listed beside this one and can be called directly. " +
  "Call one directly when you are finding where something is: " +
  "list a folder, read what you find, and follow it, one call at a time, until you have the answer. " +
  "Everything else, and any work that is many calls, a loop, filtering or a total, goes through this tool.";

/**
 * The tools listed for direct calls: the ones for looking around a repository.
 *
 * Not every tool. Measured on 2026-11-24 with every tool listed, Claude Haiku made
 * direct calls for bounded work too and spent about seven times the tokens of a
 * script (docs/decisions/2.1.9-haiku-guard.md).
 */
export const LOOKING_AROUND_TOOLS: readonly string[] = ["get_repository", "list_branches", "get_file_contents", "search_code"];

/** A tool's name as a script may write it. Anything else is refused before a script is built. */
const TOOL_PATH = /^[a-z][a-z0-9_]{0,99}$/;

export class DirectCallError extends Error {
  override readonly name = "DirectCallError";
}

/**
 * The one-line script that makes a direct call. The name is checked and the
 * arguments are carried as one JSON string that the script parses, so nothing a
 * caller sends can become code.
 */
export function directCallScript(path: string, args: unknown): string {
  if (!TOOL_PATH.test(path)) throw new DirectCallError("that is not a tool's name");
  let written: string | undefined;
  try {
    written = JSON.stringify(args ?? {});
  } catch {
    written = undefined;
  }
  if (written === undefined || !written.startsWith("{")) throw new DirectCallError("the arguments must be an object");
  // Parsed, not pasted: as source text a key named "__proto__" would mean something else.
  return `return await tools.${path}(JSON.parse(${JSON.stringify(written)}));`;
}

/** A wrapped tool as it is listed for a direct call. */
export interface DirectTool {
  /** The tool's name, the same one a script writes after `tools.`. */
  readonly path: string;
  readonly description: string;
  /** The tool's own arguments as JSON Schema, with `project` added. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** The model families the guard is for. A client says which model it runs; nothing checks it. */
export function wantsDirectTools(model: string | undefined): boolean {
  return model !== undefined && /haiku/i.test(model);
}

/**
 * Which tools to list for direct calls: the looking-around tools the owner has
 * approved, whose data this caller's provider route may receive at all.
 *
 * A tool above that level is left out, as it is from a script's search. Listing is
 * not permission: the call still meets every check, including the project's own level.
 */
export function directTools(
  records: readonly { readonly server: string; readonly tool: string; readonly dataClass: DataClass }[],
  definitionOf: (path: string) => { readonly description: string; readonly inputSchema: unknown } | undefined,
  ceiling: DataClass,
): DirectTool[] {
  const listed: DirectTool[] = [];
  for (const record of records) {
    if (!LOOKING_AROUND_TOOLS.includes(record.tool) || isAbove(record.dataClass, ceiling)) continue;
    const path = toolPath(record.server, record.tool);
    const definition = definitionOf(path);
    if (!TOOL_PATH.test(path) || definition === undefined) continue;
    const schema = definition.inputSchema;
    if (typeof schema !== "object" || schema === null) continue;
    const { properties, required } = schema as { properties?: unknown; required?: unknown };
    const own = typeof properties === "object" && properties !== null ? (properties as Record<string, unknown>) : {};
    // A tool with an argument of that name could not be told apart from ours.
    if (Object.hasOwn(own, "project")) continue;
    listed.push({
      path,
      description: `${definition.description} Returns ${record.dataClass} data. Runs under the same checks as a script.`,
      inputSchema: {
        ...(schema as Record<string, unknown>),
        type: "object",
        properties: { project: { type: "string", description: "The project this call belongs to, as for the code tool." }, ...own },
        required: ["project", ...(Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : [])],
      },
    });
  }
  return listed.sort((a, b) => a.path.localeCompare(b.path));
}
