/**
 * The MCP adapter (task 2.1.1, FR-10): the `code` tool as a remote MCP server
 * over Streamable HTTP, for Claude Code and Codex.
 *
 * It is a thin face. One tool is offered, `code`, and a call to it goes through
 * `codeToolService` and nothing else, so every control of the core applies. A
 * caller may also be listed a few wrapped tools to call directly (task 2.1.9);
 * each such call is turned into a script and goes through the same service. The
 * reply is handed to the model inside the untrusted-output block (FR-36).
 *
 * The protocol itself is the MCP project's own server library, chosen by the
 * project owner on 2026-11-24 over hand-written handling. It serves both the
 * 2026-07-28 revision and 2025 clients, and it keeps nothing between requests.
 *
 * This file does no sign-in. The library never reads a credential from a
 * request, and nor does this: whoever mounts the handler must have established
 * who is calling first, and passes that in as the caller. Until task 2.1.2
 * builds sign-in, it is mounted only on the test Worker, behind its secret.
 */
import { createMcpHandler, McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { attemptGate, type AttemptGate } from "../code-tool/attempts";
import { CODE_TOOL_DESCRIPTION, CODE_TOOL_NAME } from "../code-tool/description";
import { BOTH_DOORS_GUIDANCE, DirectCallError, directCallScript, type DirectTool } from "../code-tool/direct";
import { presentForModel } from "../code-tool/present";
import { codeToolInputSchema } from "../contracts/code-tool";
import { CONTRACT_VERSION } from "../contracts/version";
import type { CodeToolService } from "../service";

export const MCP_PATH = "/mcp";
export const MCP_SERVER_NAME = "execward";

/** Who is calling, as established by whoever mounted the handler. Never read from the request body. */
export interface McpCaller {
  /** How the calling client reaches its model provider: a key of `PROVIDER_ROUTES`. */
  readonly providerRoute: unknown;
  /**
   * The count of this caller's failed runs in the named project, kept between requests
   * (task 2.1.5). Without it each call is counted alone, which is only right for tests.
   */
  readonly attemptsFor?: (project: string) => Promise<AttemptGate>;
  /** Lines to add to the reply: switches that changed since this caller's last call (task 2.1.4). */
  readonly noticesFor?: (project: string) => Promise<readonly string[]>;
  /**
   * Wrapped tools to list beside `code` for direct calls (task 2.1.9). Each call is run as a
   * one-line script by the same service, so it meets every control a script meets.
   */
  readonly directTools?: readonly DirectTool[];
}

/**
 * A tool's arguments as the library wants them described. The arguments are passed on as
 * they came: the broker checks them against the tool's pinned schema, as it does for a script.
 */
function passedOn(schema: Readonly<Record<string, unknown>>): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "execward",
      validate: (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value) ? { value: value as Record<string, unknown> } : { issues: [{ message: "the arguments must be an object" }] },
      jsonSchema: { input: () => ({ ...schema }), output: () => ({ ...schema }) },
    },
  };
}

export interface McpAdapter {
  /** Serves one MCP request for a caller who has already been identified. */
  serve(request: Request, caller: McpCaller): Promise<Response>;
}

export function mcpAdapter(deps: { readonly service: CodeToolService }): McpAdapter {
  return {
    async serve(request, caller) {
      // A fresh server and handler for each request: nothing is shared between callers.
      const handler = createMcpHandler(() => {
        // The list never changes during a session (FR-14): `code`, and for a client the guard is for, a few
        // direct tools fixed by its own configuration. The library would otherwise tell clients it may change.
        const server = new McpServer({ name: MCP_SERVER_NAME, version: CONTRACT_VERSION }, { capabilities: { tools: { listChanged: false } } });
        const direct = (caller.directTools ?? []).filter((tool) => tool.path !== CODE_TOOL_NAME);
        /** One run of the code tool for this caller, and its reply as the model is given it. */
        const run = async (input: { readonly project: string } & Record<string, unknown>) => {
          // The count of failed runs in a row belongs to the caller and the project, not to this request.
          const attempts = caller.attemptsFor === undefined ? attemptGate() : await caller.attemptsFor(input.project);
          // Read before the run, so the notice describes the settings this call met.
          const notices = (await caller.noticesFor?.(input.project).catch(() => [])) ?? [];
          const ran = await deps.service(input, { providerRoute: caller.providerRoute, attempts });
          // A run may carry a notice of its own (a held result). Both are kept, within the contract's limit of eight.
          const output = notices.length === 0 ? ran : { ...ran, notices: [...(ran.notices ?? []), ...notices].slice(0, 8) };
          return {
            content: [{ type: "text" as const, text: presentForModel(output) }],
            isError: output.status === "error" || output.status === "refused",
          };
        };
        server.registerTool(
          CODE_TOOL_NAME,
          {
            title: "Run a script over the approved tools",
            description: direct.length === 0 ? CODE_TOOL_DESCRIPTION : `${CODE_TOOL_DESCRIPTION}\n\n${BOTH_DOORS_GUIDANCE}`,
            inputSchema: codeToolInputSchema,
            // Phase 2 wraps read-only tools only. This is a hint to the client, not a control.
            annotations: { readOnlyHint: true, openWorldHint: true },
          },
          (input) => run(input),
        );
        for (const tool of direct) {
          server.registerTool(
            tool.path,
            { description: tool.description, inputSchema: passedOn(tool.inputSchema), annotations: { readOnlyHint: true, openWorldHint: true } },
            async (input) => {
              const { project, ...args } = input;
              const refuse = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
              if (typeof project !== "string" || project === "") return refuse("schema_invalid: give the project this call belongs to");
              let script: string;
              try {
                script = directCallScript(tool.path, args);
              } catch (error) {
                if (error instanceof DirectCallError) return refuse(`schema_invalid: ${error.message}`);
                throw error;
              }
              // Not a second way in: the call is a script like any other from here on.
              return run({ script, project, intent: `A direct call to ${tool.path}.` });
            },
          );
        }
        return server;
      });
      try {
        return await handler.fetch(request);
      } finally {
        // The reply for a plain call is already complete; this ends anything the request left open.
        void handler.close().catch(() => undefined);
      }
    },
  };
}
