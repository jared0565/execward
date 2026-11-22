import { expect, test } from "vitest";
import type { ExecutionOutcome, ExecutionRequest, Executor, SandboxHost } from "../src/executor";

/**
 * A fake that runs nothing: it proves the interface can be implemented and used
 * without any sandbox-specific type leaking into the caller.
 */
class FakeExecutor implements Executor {
  readonly name = "fake";

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    if (request.limits.maxHostCalls < 1) {
      return {
        status: "failed",
        failure: { kind: "quota_exceeded", message: "no host calls allowed" },
        logs: [],
      };
    }
    const result = await request.host.callTool("echo_say", { text: request.script });
    return { status: "completed", result, logs: ["called echo_say"], truncated: false };
  }
}

const host: SandboxHost = {
  callTool: async (path, args) => ({ path, args }),
  search: async () => [],
  describe: async () => ({}),
};

const limits = { cpuMs: 50, wallClockMs: 5_000, maxHostCalls: 10, maxResultBytes: 1_000 };

test("a caller can run a script knowing only the Executor interface", async () => {
  const executor: Executor = new FakeExecutor();
  const outcome = await executor.execute({ runId: "run-1", script: "hello", limits, host });

  expect(outcome.status).toBe("completed");
  if (outcome.status === "completed") {
    expect(outcome.result).toEqual({ path: "echo_say", args: { text: "hello" } });
    expect(outcome.truncated).toBe(false);
  }
});

test("a failed run reports a failure kind and no result", async () => {
  const executor: Executor = new FakeExecutor();
  const outcome = await executor.execute({
    runId: "run-2",
    script: "hello",
    limits: { ...limits, maxHostCalls: 0 },
    host,
  });

  expect(outcome.status).toBe("failed");
  if (outcome.status === "failed") {
    expect(outcome.failure.kind).toBe("quota_exceeded");
    expect("result" in outcome).toBe(false);
  }
});
