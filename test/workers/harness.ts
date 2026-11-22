/**
 * Test-only Worker. It runs the real Dynamic Worker executor inside the local
 * Workers runtime, against a scripted `SandboxHost`, so the tests in
 * ../executor-dynamic-worker.test.ts can observe what a script can and cannot
 * do. It is never deployed; production has no route that runs a script yet.
 */
import type { ExecutionLimits, SandboxHost } from "../../src/executor";
import { dynamicWorkerExecutor, type WorkerLoader } from "../../src/executor/dynamic-worker";

interface RunBody {
  readonly script: string;
  readonly limits?: Partial<ExecutionLimits>;
}

const DEFAULT_LIMITS: ExecutionLimits = { cpuMs: 1_000, wallClockMs: 5_000, maxHostCalls: 100, maxResultBytes: 32 * 1024 };

function scriptedHost(calls: { path: string; args: unknown }[]): SandboxHost {
  return {
    async callTool(path, args) {
      calls.push({ path, args });
      if (path === "test_fail") throw new Error("upstream said no");
      if (path === "test_slow") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { slow: true };
      }
      return { path, args };
    },
    async search(query) {
      calls.push({ path: "search", args: query });
      return ["test_echo"];
    },
    async describe(path) {
      calls.push({ path: "describe", args: path });
      return { path, description: "Echoes its arguments." };
    },
  };
}

export default {
  async fetch(request: Request, env: { LOADER: WorkerLoader }): Promise<Response> {
    const body = (await request.json()) as RunBody;
    const calls: { path: string; args: unknown }[] = [];
    const outcome = await dynamicWorkerExecutor(env.LOADER).execute({
      runId: "test-run",
      script: body.script,
      limits: { ...DEFAULT_LIMITS, ...body.limits },
      host: scriptedHost(calls),
    });
    // Give a script that outlived its run a moment to try another call.
    if (new URL(request.url).searchParams.has("linger")) await new Promise((resolve) => setTimeout(resolve, 500));
    return Response.json({ outcome, calls });
  },
};
