/**
 * Test-only Worker. It runs the real Dynamic Worker executor inside the local
 * Workers runtime, against a scripted `SandboxHost`, so the tests in
 * ../executor-dynamic-worker.test.ts can observe what a script can and cannot
 * do. It is never deployed; production has no route that runs a script yet.
 */
import type { DataClass } from "../../src/contracts/policy";
import type { ExecutionLimits } from "../../src/executor";
import migration from "../../migrations/0001_policy.sql";
import { brokerHost } from "../../src/broker/broker";
import { d1PolicyStore, putPolicyRecord, type D1Like } from "../../src/broker/policy-store";
import { runCodeTool, type RunHost } from "../../src/code-tool/run";
import { dynamicWorkerExecutor, type WorkerLoader } from "../../src/executor/dynamic-worker";

interface PolicyBody {
  readonly records?: readonly unknown[];
  readonly rawRows?: readonly { path: string; record: string }[];
  readonly noTable?: boolean;
  readonly get?: string;
  readonly input?: unknown;
  readonly inputSchema?: unknown;
  readonly allowedDataClass?: DataClass;
}

interface RunBody {
  readonly script: string;
  readonly limits?: Partial<ExecutionLimits>;
}

const DEFAULT_LIMITS: ExecutionLimits = { cpuMs: 1_000, wallClockMs: 5_000, maxHostCalls: 100, maxResultBytes: 32 * 1024 };

function scriptedHost(calls: { path: string; args: unknown }[]): RunHost {
  return {
    // This stand-in reads nothing classified, so output hygiene withholds nothing.
    provenance: () => ({ dataClass: undefined, records: 0 }),
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
  async fetch(request: Request, env: { LOADER: WorkerLoader; DB: D1Like }): Promise<Response> {
    const calls: { path: string; args: unknown }[] = [];
    const route = new URL(request.url).pathname;
    if (route === "/policy" || route === "/brokered") {
      // A fresh policy table on the local D1 database for every request.
      const body = (await request.json()) as PolicyBody;
      await env.DB.prepare("DROP TABLE IF EXISTS policy").bind().run();
      if (!body.noTable) await env.DB.prepare(migration).bind().run();
      for (const record of body.records ?? []) await putPolicyRecord(env.DB, record);
      for (const row of body.rawRows ?? []) {
        await env.DB.prepare("INSERT INTO policy (path, record) VALUES (?1, ?2)").bind(row.path, row.record).run();
      }
      const store = d1PolicyStore(env.DB);
      if (route === "/policy") {
        const read = async (work: () => Promise<unknown>) => {
          try {
            return { value: (await work()) ?? null };
          } catch (error) {
            return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
          }
        };
        return Response.json({ got: await read(() => store.get(body.get ?? "")), list: await read(() => store.list()) });
      }
      // The whole stack: code tool, static check, Dynamic Worker, broker, policy table.
      const output = await runCodeTool(body.input, {
        executor: dynamicWorkerExecutor(env.LOADER),
        hostFor: () =>
          brokerHost({
            store,
            definitionFor: async () => ({ description: "test tool", inputSchema: body.inputSchema ?? { type: "object", additionalProperties: true } }),
            upstream: async ({ record, args }) => {
              calls.push({ path: `${record.server}/${record.tool}`, args });
              return { from: record.tool, args };
            },
          }),
        allowedDataClass: () => body.allowedDataClass ?? "internal",
        newRunId: () => "brokered-run",
        now: () => Date.now(),
      });
      return Response.json({ output, calls });
    }
    if (new URL(request.url).pathname === "/code-tool") {
      // The whole run path: input contract, static check, executor, output contract.
      let runs = 0;
      const output = await runCodeTool(await request.json(), {
        executor: dynamicWorkerExecutor(env.LOADER),
        hostFor: () => scriptedHost(calls),
        newRunId: () => `test-run-${++runs}`,
        now: () => Date.now(),
      });
      return Response.json({ output, calls });
    }
    const body = (await request.json()) as RunBody;
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
