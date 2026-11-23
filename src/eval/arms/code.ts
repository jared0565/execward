/**
 * The Code Mode arm of the eval (task 1.9.5). The model is offered one tool,
 * `code`, and nothing else. It finds the wrapped tools with `search()` inside a
 * script, and only what a script returns enters the conversation.
 *
 * The tool is offered and its result presented exactly as the test app does
 * (src/app/agent.ts): the same definition, the same wrapping of results as
 * untrusted data, and the same retry limit per task. So what is measured is
 * what a client of ExecWard would get.
 *
 * The wrapper holds the task's retry count, so make a new one for every run.
 */
import { CODE_TOOL_DEFINITION } from "../../app/agent";
import { attemptGate } from "../../code-tool/attempts";
import { CODE_TOOL_NAME } from "../../code-tool/description";
import { presentForModel } from "../../code-tool/present";
import { codeToolOutputSchema, type CodeToolOutput } from "../../contracts/code-tool";
import type { ToolBackend } from "../types";

/** Runs one script: the code tool, wherever it is served. */
export type CodeRunner = (input: { script: unknown; project: string; intent?: unknown; criteria?: unknown }) => Promise<unknown>;

export interface CodeBackend extends ToolBackend {
  /** One per `code` call, in order: how each run ended. */
  readonly outcomes: { status: CodeToolOutput["status"]; errorCode?: string; errorMessage?: string; calls: number; truncated: boolean }[];
}

export function codeBackend(run: CodeRunner, project = "eval"): CodeBackend {
  const attempts = attemptGate();
  const outcomes: CodeBackend["outcomes"] = [];
  return {
    definitions: [CODE_TOOL_DEFINITION],
    outcomes,
    async call(name, args) {
      if (name !== CODE_TOOL_NAME) throw new Error(`"${name.slice(0, 80)}" is not offered here. Use the code tool.`);
      const given = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
      const blocked = attempts.blocked();
      const output: CodeToolOutput = blocked
        ? {
            status: "refused",
            error: blocked,
            report: {
              runId: "not-run",
              scriptHash: "0".repeat(64),
              callsByTool: {},
              recordsRead: 0,
              recordsWritten: 0,
              errors: [blocked],
              retries: attempts.retries(),
              assertions: { passed: 0, failed: 0 },
              sideEffects: [],
              verification: "not_applicable",
              durationMs: 0,
            },
          }
        : codeToolOutputSchema.parse(
            await run({
              script: given.script,
              project,
              ...(given.intent === undefined ? {} : { intent: given.intent }),
              ...(given.criteria === undefined ? {} : { criteria: given.criteria }),
            }),
          );
      await attempts.settle(output);
      outcomes.push({
        status: output.status,
        ...("error" in output ? { errorCode: output.error.code, errorMessage: output.error.message.slice(0, 200) } : {}),
        calls: Object.values(output.report.callsByTool).reduce((sum, count) => sum + count, 0),
        truncated: output.status === "completed" && output.truncated,
      });
      const shown = presentForModel(output);
      // The harness marks a thrown error as a failed tool call, which is what a failed run is.
      if (output.status !== "completed") throw new Error(shown);
      return shown;
    },
  };
}

/** The code tool as served by the deployed test Worker, over the invented GitHub of the eval. */
export function remoteFixtureRunner(urlBase: string, secret: string): CodeRunner {
  return async (input) => {
    const response = await fetch(`${urlBase}/fixture`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ input }) });
    if (!response.ok) throw new Error(`the test Worker answered ${response.status}`);
    return ((await response.json()) as { output: unknown }).output;
  };
}
