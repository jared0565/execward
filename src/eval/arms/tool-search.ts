/**
 * The tool-search arm of the eval (task 0.2.5). The model is offered two tools
 * and nothing else: `search_tools` finds tools and returns their definitions, and
 * `call_tool` calls one that has been found. Tool definitions therefore enter the
 * conversation only when asked for. This measures what deferring definitions
 * saves, without any code tool.
 *
 * The list of offered tools never changes during a run. An earlier design added
 * each found tool to the list; Claude rejects that, because its thinking blocks
 * are bound to the exact tool list they were written under (measured 2026-11-22,
 * see docs/decisions/0.2.5-tool-search-arm.md).
 *
 * The search runs here in the harness, not in a provider's own tool-search
 * feature, so both model families are measured the same way on every route.
 *
 * The wrapper keeps the set of found tools, so make a new one for every run.
 */
import type { ToolBackend, ToolDefinition } from "../types";

export const SEARCH_TOOL_NAME = "search_tools";
export const CALL_TOOL_NAME = "call_tool";

const DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: SEARCH_TOOL_NAME,
    description:
      "Find tools by keyword. Returns each matching tool's name, description and input schema. " +
      `A tool must be found here before ${CALL_TOOL_NAME} can call it.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words for what you want to do, for example: list issues",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: CALL_TOOL_NAME,
    description: `Call a tool that ${SEARCH_TOOL_NAME} has returned, with arguments that follow that tool's input schema.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The tool's name, as returned by the search" },
        arguments: { type: "object", description: "The tool's arguments" },
      },
      required: ["name", "arguments"],
    },
  },
];

/** Lower-case words, with a plural "s" dropped so "issues" finds "issue". */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((word) =>
    word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
  );
}

export interface ToolSearchOptions {
  /** Most tools one search returns. */
  readonly maxResults?: number;
}

export function toolSearchBackend(inner: ToolBackend, options: ToolSearchOptions = {}): ToolBackend {
  const maxResults = options.maxResults ?? 5;
  const found = new Set<string>();

  const search = (query: string): ToolDefinition[] => {
    const wanted = new Set(words(query));
    return inner.definitions
      .map((tool) => {
        const inName = new Set(words(tool.name));
        const inDescription = new Set(words(tool.description));
        let score = 0;
        // A word in the name says more about a tool than a word in its description.
        for (const word of wanted) score += inName.has(word) ? 3 : inDescription.has(word) ? 1 : 0;
        return { tool, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((entry) => entry.tool);
  };

  return {
    definitions: DEFINITIONS,
    call(name, args) {
      if (name === SEARCH_TOOL_NAME) {
        const query = (args as { query?: unknown } | null)?.query;
        if (typeof query !== "string" || query.trim() === "") {
          return Promise.reject(new Error(`${SEARCH_TOOL_NAME} needs a query string`));
        }
        const matches = search(query);
        for (const tool of matches) found.add(tool.name);
        return Promise.resolve(
          matches.length === 0
            ? { tools: [], note: "No tool matched. Try different words." }
            : {
                tools: matches.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
              },
        );
      }
      if (name === CALL_TOOL_NAME) {
        const request = args as { name?: unknown; arguments?: unknown } | null;
        if (typeof request?.name !== "string") {
          return Promise.reject(new Error(`${CALL_TOOL_NAME} needs the tool's name`));
        }
        if (!found.has(request.name)) {
          return Promise.reject(
            new Error(`the tool ${request.name} has not been found; find it with ${SEARCH_TOOL_NAME} first`),
          );
        }
        return inner.call(request.name, request.arguments ?? {});
      }
      return Promise.reject(
        new Error(`${name} cannot be called directly; use ${SEARCH_TOOL_NAME}, then ${CALL_TOOL_NAME}`),
      );
    },
  };
}
