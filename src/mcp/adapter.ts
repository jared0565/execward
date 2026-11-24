/**
 * The MCP adapter (task 2.1.1, FR-10): the `code` tool as a remote MCP server
 * over Streamable HTTP, for Claude Code and Codex.
 *
 * It is a thin face. One tool is offered, `code`, and a call to it goes through
 * `codeToolService` and nothing else, so every control of the core applies. The
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
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { attemptGate } from "../code-tool/attempts";
import { CODE_TOOL_DESCRIPTION, CODE_TOOL_NAME } from "../code-tool/description";
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
        // The list is one tool and never changes (FR-14). The library would otherwise tell clients it may.
        const server = new McpServer({ name: MCP_SERVER_NAME, version: CONTRACT_VERSION }, { capabilities: { tools: { listChanged: false } } });
        server.registerTool(
          CODE_TOOL_NAME,
          {
            title: "Run a script over the approved tools",
            description: CODE_TOOL_DESCRIPTION,
            inputSchema: codeToolInputSchema,
            // Phase 2 wraps read-only tools only. This is a hint to the client, not a control.
            annotations: { readOnlyHint: true, openWorldHint: true },
          },
          async (input) => {
            // One attempt gate per call for now: counting attempts across a session is task 2.1.5.
            const output = await deps.service(input, { providerRoute: caller.providerRoute, attempts: attemptGate() });
            return {
              content: [{ type: "text" as const, text: presentForModel(output) }],
              isError: output.status === "error" || output.status === "refused",
            };
          },
        );
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
