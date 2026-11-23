/**
 * Test-only Worker. It runs the real Dynamic Worker executor inside the local
 * Workers runtime, against a scripted `SandboxHost`, so the tests in
 * ../executor-dynamic-worker.test.ts can observe what a script can and cannot
 * do. It is never deployed; production has no route that runs a script yet.
 */
import type { DataClass } from "../../src/contracts/policy";
import type { ExecutionLimits } from "../../src/executor";
import migration from "../../migrations/0001_policy.sql";
import auditMigration from "../../migrations/0002_audit_log.sql";
import stateMigration from "../../migrations/0003_state.sql";
import { d1ControlStore, d1EscalationStore, d1ProjectStore, d1QuotaStore, putProjectRecord, sweepQuotaCounters, type StateDatabase } from "../../src/storage/d1-stores";
import { applyRetention, auditLog, d1AuditStore, deleteProjectLogs, memoryAuditStore, verifyChain, type AuditDatabase } from "../../src/audit/log";
import { brokerHost } from "../../src/broker/broker";
import { d1PolicyStore, putPolicyRecord, type D1Like } from "../../src/broker/policy-store";
import { runCodeTool, type RunHost } from "../../src/code-tool/run";
import { dynamicWorkerExecutor, type WorkerLoader } from "../../src/executor/dynamic-worker";

interface AuditBody {
  readonly events: readonly { kind: string; runId: string; project: string; security?: boolean; body: unknown; ageDays?: number }[];
  readonly together?: boolean;
  readonly retention?: boolean;
  readonly eraseProject?: string;
  readonly tamper?: readonly string[];
}

interface StoreOp {
  readonly store: string;
  readonly op: string;
  readonly args: readonly unknown[];
}

interface StoresBody {
  readonly ops: readonly StoreOp[];
  readonly together?: boolean;
  readonly noTables?: boolean;
  readonly rawSql?: readonly string[];
}

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
    if (route === "/stores") {
      // The database-backed stores on the local D1 database. Each request starts from empty tables
      // and runs a list of operations, in order or all at once, returning each one's result.
      const body = (await request.json()) as StoresBody;
      const db = env.DB as unknown as StateDatabase;
      for (const table of ["quota_counters", "quota_slots", "control_state", "escalations", "projects"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).bind().run();
      if (!body.noTables) {
        // One statement at a time, with the comment lines taken out first.
        const sql = stateMigration
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n");
        for (const statement of sql.split(";")) if (statement.trim() !== "") await db.prepare(statement).bind().run();
      }
      for (const sql of body.rawSql ?? []) await db.prepare(sql).bind().run();
      const stores: Record<string, Record<string, (...args: never[]) => Promise<unknown>>> = {
        quota: d1QuotaStore(db) as never,
        control: d1ControlStore(db) as never,
        escalations: d1EscalationStore(db) as never,
        projects: { ...d1ProjectStore(db), put: (record: never, gate: never) => putProjectRecord(db, record, gate) } as never,
        sweep: { counters: (now: never) => sweepQuotaCounters(db, now) } as never,
      };
      const perform = async (op: StoreOp): Promise<unknown> => {
        try {
          const result = await stores[op.store]?.[op.op]?.(...(op.args as never[]));
          return { value: result ?? null };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      };
      const results: unknown[] = [];
      if (body.together) results.push(...(await Promise.all(body.ops.map(perform))));
      else for (const op of body.ops) results.push(await perform(op));
      const counters = body.noTables ? [] : (await db.prepare("SELECT id, total FROM quota_counters ORDER BY id").all<{ id: string; total: number }>()).results;
      return Response.json({ results, counters });
    }
    if (route === "/audit") {
      // The audit log on the local D1 database: write events, optionally try to tamper, then read back.
      const body = (await request.json()) as AuditBody;
      const db = env.DB as unknown as AuditDatabase;
      for (const name of ["audit_log_no_update", "audit_log_no_delete"]) await db.prepare(`DROP TRIGGER IF EXISTS ${name}`).bind().run();
      await db.prepare("DROP TABLE IF EXISTS audit_log").bind().run();
      await db.prepare("DROP TABLE IF EXISTS audit_anchor").bind().run();
      // One statement at a time: the table, then each trigger.
      for (const statement of auditMigration.split(/;\s*\n(?=CREATE)/)) await db.prepare(statement).bind().run();
      const store = d1AuditStore(db);
      // Each event is written at its own time: `ageDays` old, or now.
      let writing = 0;
      const startedAt = Date.now();
      const log = auditLog(store, () => startedAt - (body.events[writing]?.ageDays ?? 0) * 86_400_000);
      const writes = body.together
        ? await Promise.allSettled(body.events.map((event) => log.record(event)))
        : await (async () => {
            const done: PromiseSettledResult<void>[] = [];
            for (const event of body.events) {
              done.push(...(await Promise.allSettled([log.record(event)])));
              writing++;
            }
            return done;
          })();
      const tamper: string[] = [];
      for (const sql of body.tamper ?? []) {
        try {
          await db.prepare(sql).bind().run();
          tamper.push("ran");
        } catch (error) {
          tamper.push(error instanceof Error ? error.message : String(error));
        }
      }
      const retention = body.retention ? await applyRetention(store, startedAt) : undefined;
      const erased = body.eraseProject === undefined ? undefined : await deleteProjectLogs(store, auditLog(store, () => startedAt), body.eraseProject);
      const entries = await store.all();
      const anchor = (await store.anchor()) ?? null;
      return Response.json({
        written: writes.filter((write) => write.status === "fulfilled").length,
        tamper,
        retention,
        erased,
        anchor,
        entries,
        chain: await verifyChain(entries, anchor ?? undefined),
      });
    }
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
        audit: auditLog(memoryAuditStore(), () => Date.now()),
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
        audit: auditLog(memoryAuditStore(), () => Date.now()),
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
