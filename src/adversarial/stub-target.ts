/**
 * The stub target (task 0.3.2): a `code` tool with no defences at all.
 *
 * It runs a script in this process with the host's globals in reach, calls
 * every tool it is given, and ignores policy, limits, pins and schemas. It
 * exists to prove the suite can tell: every attack case must be reported as
 * NOT defended here, or that case would pass against anything.
 *
 * Never use this to run a script from a model. It is a test double.
 */
import { toolPath } from "../contracts/sandbox-api";
import type { RunResult, ScriptRun, Target, ToolFixture } from "./types";

type ScriptFunction = (...scope: unknown[]) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* used only to reach the constructor */
}).constructor as new (...parameters: string[]) => ScriptFunction;

async function runScript(run: ScriptRun): Promise<RunResult> {
  const logs: string[] = [];
  const tools: Record<string, (args?: unknown) => Promise<unknown>> = {};
  for (const fixture of run.tools) {
    tools[toolPath(fixture.server, fixture.tool)] = async (args) => fixture.handler(args);
  }
  const scope = {
    tools,
    search: async () => run.tools.map((fixture) => toolPath(fixture.server, fixture.tool)),
    describe: async (path: string) =>
      run.tools.find((fixture) => toolPath(fixture.server, fixture.tool) === path)?.description ?? null,
    assert: (condition: unknown, message?: string) => {
      if (!condition) throw new Error(message ?? "assertion failed");
    },
    console: { log: (...values: unknown[]) => logs.push(values.map(String).join(" ")) },
  };
  try {
    const script = new AsyncFunction(...Object.keys(scope), run.script);
    const result = await script(...Object.values(scope));
    return { status: "completed", result, logs };
  } catch {
    return { status: "error", errorCode: "script_error", logs };
  }
}

export function stubTarget(): Target {
  const logLines: string[] = [];
  let handles = 0;
  return {
    name: "stub (no defences)",
    runScript,
    typingsFor: async (tools: readonly ToolFixture[]) =>
      tools
        .map((fixture) => `/** ${fixture.description} */\n${toolPath(fixture.server, fixture.tool)}(args): Promise<unknown>;`)
        .join("\n"),
    acceptsToken: async () => true,
    pausedRuns: {
      pause: async () => String(++handles),
      resume: async () => true,
    },
    approvals: {
      request: async () => String(++handles),
      approve: async () => true,
      execute: async () => true,
    },
    saveScript: async () => true,
    auditLog: {
      record: async (event) => {
        logLines.push(event);
        return [...logLines];
      },
      verify: async () => true,
    },
    localRequest: async () => "served",
    consoleSignIn: async () => true,
    processReach: async () => ({ shellEnvironment: true, filesOutsideProject: true }),
    supplyChain: async () => ({ lockfile: false, exactVersions: false, sbom: false }),
    review: async () => "passed",
    securityException: async (project) => ({ pausedProjects: [project, "every-other-project"], sourceShown: false }),
  };
}
