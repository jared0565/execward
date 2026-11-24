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
import attemptsMigration from "../../migrations/0004_attempts.sql";
import seenMigration from "../../migrations/0005_switches_seen.sql";
import { switchNotices } from "../../src/mcp/switch-notice";
import { attemptKey, storedAttemptGate } from "../../src/code-tool/stored-attempts";
import { d1AttemptStore, d1ControlStore, d1EscalationStore, d1ProjectStore, d1QuotaStore, putProjectRecord, sweepQuotaCounters, type StateDatabase, d1SettingsSeenStore } from "../../src/storage/d1-stores";
import { applyRetention, auditLog, d1AuditStore, deleteProjectLogs, memoryAuditStore, verifyChain, type AuditDatabase } from "../../src/audit/log";
import { BACKUP_TABLES, backUp, restore, type BackupBucket, type BackupDatabase } from "../../src/backup";
import { brokerHost } from "../../src/broker/broker";
import { d1PolicyStore, memoryPolicyStore, putPolicyRecord, type D1Like } from "../../src/broker/policy-store";
import { githubPinsAndPolicy, githubUpstream } from "../../src/connectors/github";
import { appJwt } from "../../src/connectors/github-app";
import { outboundFetch } from "../../src/net/outbound";
import { approve, registry, type Pin } from "../../src/registry/registry";
import { githubFixtureBackend } from "../../src/eval/fixtures/github-backend";
import { buildWorld } from "../../src/eval/fixtures/world";
import { GITHUB_READ_ONLY_TOOLS } from "../../src/tools/github-inventory";
import type { PolicyRecord } from "../../src/contracts/policy";
import type { ToolBackend } from "../../src/eval/types";
import { escalationQueue } from "../../src/console/escalations";
import { attemptGate } from "../../src/code-tool/attempts";
import { meter, memoryMeterSink } from "../../src/meter/meter";
import { logMetricsSink } from "../../src/metrics/metrics";
import { codeToolService } from "../../src/service";
import { mcpAdapter, MCP_PATH } from "../../src/mcp/adapter";
import { runScheduled } from "../../src/worker/scheduled";
import { runCodeTool, type RunHost } from "../../src/code-tool/run";
import { dynamicWorkerExecutor, type WorkerLoader } from "../../src/executor/dynamic-worker";
import { ADVERSARIAL_CASES, execwardTarget, JUDGED_FROM_THE_BUILD, runSuite } from "../../src/adversarial";

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

interface BackupBody {
  readonly now?: number;
  readonly auditEvents?: number;
  /** Objects put in the bucket before the backup, to see which are deleted. */
  readonly olderObjects?: readonly string[];
  readonly tamperBackup?: boolean;
  readonly restoreKey?: string;
  readonly restoreTwice?: boolean;
}

interface ScheduledBody {
  /** The times the timer fires at, in order. */
  readonly times: readonly number[];
  /** Write one audit entry this many days before the first firing. */
  readonly oldEntryDays?: number;
  /** Raise an escalation a day before the first firing, so that it is past its time limit. */
  readonly expiredEscalation?: boolean;
  readonly brokenBucket?: boolean;
}

interface GithubBody {
  readonly input?: unknown;
  readonly configured?: boolean;
  readonly writeProbe?: { readonly owner: string; readonly repo: string };
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

/**
 * The invented GitHub the eval uses (src/eval/fixtures), wrapped as the real tools are: each tool
 * approved and pinned, with the policy record from the inventory. Built once and kept, since it never changes.
 */
let fixtureStack: Promise<{ backend: ToolBackend; pins: Pin[]; records: PolicyRecord[] }> | undefined;
function fixture(): Promise<{ backend: ToolBackend; pins: Pin[]; records: PolicyRecord[] }> {
  fixtureStack ??= (async () => {
    const backend = githubFixtureBackend(buildWorld());
    const pins: Pin[] = [];
    const records: PolicyRecord[] = [];
    for (const tool of backend.definitions) {
      const draft = GITHUB_READ_ONLY_TOOLS.find((entry) => entry.tool === tool.name);
      if (!draft) throw new Error(`the fixture tool "${tool.name}" is not in the inventory`);
      const pin = await approve({ server: "github", tool: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      pins.push(pin);
      records.push({
        server: draft.server,
        tool: draft.tool,
        definitionHash: pin.hash,
        callerRule: draft.callerRule,
        dataClass: draft.dataClass,
        tier: draft.tier,
        sensitive: draft.sensitive,
        outbound: draft.outbound,
        destinationAllowlist: [...draft.destinationAllowlist],
        quotas: { ...draft.quotas },
      });
    }
    return { backend, pins, records };
  })();
  return fixtureStack;
}

/** Drops every table and builds them again from the three migrations. */
async function emptyTables(db: BackupDatabase & AuditDatabase & StateDatabase): Promise<void> {
  for (const name of ["audit_log_no_update", "audit_log_no_delete"]) await db.prepare(`DROP TRIGGER IF EXISTS ${name}`).bind().run();
  for (const table of [...BACKUP_TABLES, "quota_counters", "quota_slots", "attempt_state", "switches_seen"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).bind().run();
  await db.prepare(migration).bind().run();
  for (const statement of auditMigration.split(/;\s*\n(?=CREATE)/)) await db.prepare(statement).bind().run();
  const state = stateMigration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const statement of state.split(";")) if (statement.trim() !== "") await db.prepare(statement).bind().run();
  // Each of these is one statement.
  for (const sql of [attemptsMigration, seenMigration]) {
    await db
      .prepare(
        sql
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .replace(";", ""),
      )
      .bind()
      .run();
  }
}

/**
 * The code tool as production will serve it (src/service.ts), with every store on the database:
 * policy table, project classes, switches, quota counters and the audit log. The tools are the invented GitHub.
 */
async function databaseService(env: { LOADER: WorkerLoader; DB: D1Like }) {
  const db = env.DB as unknown as BackupDatabase & AuditDatabase & StateDatabase;
  const { backend, pins } = await fixture();
  const pinned = registry({ pins, current: async (path) => pins.find((pin) => pin.path === path)?.definition });
  const auditStore = d1AuditStore(db);
  const service = codeToolService({
    executor: dynamicWorkerExecutor(env.LOADER),
    policy: d1PolicyStore(env.DB),
    projects: d1ProjectStore(db),
    quotas: d1QuotaStore(db),
    audit: auditStore,
    control: d1ControlStore(db),
    upstream: ({ record, args }) => backend.call(record.tool, args),
    definitionFor: (record) => pinned.definitionFor(record),
    docsFor: (path) => pinned.docsFor(path),
    meter: meter({ level: "off", sink: memoryMeterSink() }),
    metrics: logMetricsSink(),
    now: () => Date.now(),
    newRunId: () => crypto.randomUUID(),
  });
  return { service, auditStore };
}

export default {
  async fetch(request: Request, env: { LOADER: WorkerLoader; DB: D1Like; GITHUB_TOKEN?: string; BACKUPS?: BackupBucket }): Promise<Response> {
    const calls: { path: string; args: unknown }[] = [];
    const route = new URL(request.url).pathname;
    if (route === "/backup" || route === "/scheduled") {
      // Task 1.4.5: fill a database, back it up to the bucket, empty the database, restore, and compare.
      const body = (await request.json()) as BackupBody;
      const bucket = env.BACKUPS;
      if (!bucket) return Response.json({ error: "no bucket" }, { status: 500 });
      const db = env.DB as unknown as BackupDatabase & AuditDatabase & StateDatabase;
      const now = body.now ?? Date.now();
      const freshTables = (): Promise<void> => emptyTables(db);
      // An empty bucket prefix and empty tables for every request.
      for (let page = await bucket.list({ prefix: "backups/" }); ; page = await bucket.list({ prefix: "backups/", ...(page.cursor === undefined ? {} : { cursor: page.cursor }) })) {
        if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
        if (!page.truncated) break;
      }
      await freshTables();

      if (route === "/scheduled") {
        // The production Worker's timer, fired at each of the given times against this database and bucket.
        const timer = body as unknown as ScheduledBody;
        const first = timer.times[0] ?? Date.now();
        const store = d1AuditStore(db);
        if (timer.oldEntryDays !== undefined) {
          await auditLog(store, () => first - timer.oldEntryDays! * 86_400_000).record({ kind: "test", runId: "old-run", project: "work", body: { text: "old text" } });
        }
        if (timer.expiredEscalation) {
          const queue = escalationQueue({ store: d1EscalationStore(db), control: d1ControlStore(db), audit: auditLog(store, () => first - 86_400_000), now: () => first - 86_400_000, newId: () => "expiredItem0123456789" });
          await queue.raise({ trigger: "repeated_failure", project: "work", runId: "run-1" });
        }
        let ids = 0;
        const runs = [];
        for (const at of timer.times) runs.push(await runScheduled({ DB: env.DB, BACKUPS: timer.brokenBucket ? { ...bucket, put: async () => Promise.reject(new Error("the bucket refused the write")) } : bucket }, at, () => `id-${++ids}`));
        const entries = await store.all();
        return Response.json({
          runs,
          keys: (await bucket.list({ prefix: "" })).objects.map((object) => object.key).sort(),
          kinds: entries.map((entry) => entry.kind),
          oldTextRemoved: entries[0]?.content === null,
          chain: await verifyChain(entries, (await store.anchor()) ?? undefined),
          escalationStatuses: (await d1EscalationStore(db).all()).map((item) => item.status),
        });
      }

      // Something in every table.
      const { records } = await githubPinsAndPolicy();
      for (const record of records.slice(0, 3)) await putPolicyRecord(env.DB, record);
      const auditStore = d1AuditStore(db);
      const log = auditLog(auditStore, () => now);
      for (let n = 0; n < (body.auditEvents ?? 5); n++) await log.record({ kind: "test", runId: `run-${n}`, project: "work", body: { text: `entry ${n}`, quote: 'a "quoted" line\nand another' } });
      await d1ControlStore(db).write({ codeMode: true, killed: false, pausedProjects: ["paused-one"], blockedTools: [], version: 1 }, 0);
      await putProjectRecord(db, { project: "work", dataClass: "internal" });
      await db.prepare("INSERT INTO escalations (id, status, created_at, item) VALUES (?1, ?2, ?3, ?4)").bind("item-1", "open", now, JSON.stringify({ id: "item-1" })).run();
      for (const key of body.olderObjects ?? []) await bucket.put(key, "{}", { customMetadata: { sha256: "0" } });

      const before = { entries: await auditStore.all(), anchor: (await auditStore.anchor()) ?? null };
      const taken = await backUp(db, bucket, now);
      const keys = (await bucket.list({ prefix: "" })).objects.map((object) => object.key).sort();
      if (body.tamperBackup) await bucket.put(taken.key, (await (await bucket.get(taken.key))!.text()).replace("entry 1", "entry X"), { customMetadata: { sha256: taken.sha256 } });

      // The scratch database: the same one, emptied.
      await freshTables();
      let restored: unknown;
      try {
        if (body.restoreTwice) await restore(db, bucket, taken.key);
        restored = { rows: await restore(db, bucket, body.restoreKey ?? taken.key) };
      } catch (error) {
        restored = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
      const after = { entries: await d1AuditStore(db).all(), anchor: (await d1AuditStore(db).anchor()) ?? null };
      return Response.json({
        taken,
        keys,
        restored,
        sameAuditLog: JSON.stringify(before) === JSON.stringify(after),
        chain: await verifyChain(after.entries, after.anchor ?? undefined),
        control: await d1ControlStore(db).read().catch((error: Error) => `error: ${error.message}`),
        policyPaths: (await d1PolicyStore(env.DB).list()).map((record) => `${record.server}_${record.tool}`).sort(),
        project: (await d1ProjectStore(db).get("work")) ?? null,
        escalations: (await db.prepare("SELECT id FROM escalations").bind().all<{ id: string }>()).results.length,
      });
    }
    if (route === "/service") {
      // The code tool as production will serve it (src/service.ts), with every store on the
      // database: policy table, project classes, switches, quota counters and the audit log.
      // `setup` empties the tables and fills the policy; later requests run against what is there.
      const body = (await request.json()) as { setup?: boolean; codeMode?: boolean; projects?: number; verify?: boolean; input?: unknown; flip?: { codeMode?: boolean; pause?: string; resume?: string } };
      const db = env.DB as unknown as BackupDatabase & AuditDatabase & StateDatabase;
      const { records } = await fixture();
      if (body.setup) {
        await emptyTables(db);
        for (const record of records) await putPolicyRecord(env.DB, record);
        await putProjectRecord(db, { project: "eval", dataClass: "confidential" });
        // More projects for a timed run, which would otherwise meet one project's limit of runs a minute.
        for (let index = 0; index < Math.min(body.projects ?? 0, 100); index++) await putProjectRecord(db, { project: `eval-${index}`, dataClass: "confidential" });
        // Code Mode is off until the owner switches it on. The setup does that unless told not to.
        const control = d1ControlStore(db);
        const state = await control.read();
        if (body.codeMode !== false) await control.write({ ...state, codeMode: true, version: state.version + 1 }, state.version);
        return Response.json({ ready: records.length });
      }
      if (body.flip) {
        // Changes one switch and nothing else, as the owner would from the console (task 2.1.4).
        const control = d1ControlStore(db);
        const state = await control.read();
        const paused = new Set(state.pausedProjects);
        if (body.flip.pause) paused.add(body.flip.pause);
        if (body.flip.resume) paused.delete(body.flip.resume);
        const next = { ...state, codeMode: body.flip.codeMode ?? state.codeMode, pausedProjects: [...paused], version: state.version + 1 };
        return Response.json({ changed: await control.write(next, state.version) });
      }
      const { service, auditStore } = await databaseService(env);
      const output = await service(body.input, { providerRoute: "anthropic_api_commercial", attempts: attemptGate() });
      // Reading the whole log back is for tests. It is left out of a timed run.
      if (!body.verify) return Response.json({ output });
      const entries = await auditStore.all();
      return Response.json({ output, auditEntries: entries.length, chain: await verifyChain(entries, (await auditStore.anchor()) ?? undefined) });
    }
    if (route === MCP_PATH) {
      // The MCP adapter over the same service (task 2.1.1). The caller is whoever passed this Worker's own
      // gate; sign-in for model clients is task 2.1.2. Run `/service` with `setup` first.
      // Failed runs in a row are counted in the database, per project, as production counts them (task 2.1.5).
      const { service } = await databaseService(env);
      const attempts = d1AttemptStore(env.DB as unknown as StateDatabase);
      return mcpAdapter({ service }).serve(request, {
        providerRoute: "anthropic_api_commercial",
        attemptsFor: (project) => storedAttemptGate({ store: attempts, now: () => Date.now() }, attemptKey("test-client", project)),
        noticesFor: (project) =>
          switchNotices(
            { store: d1SettingsSeenStore(env.DB as unknown as StateDatabase), control: d1ControlStore(env.DB as unknown as StateDatabase), now: () => Date.now() },
            attemptKey("test-client", project),
            project,
          ),
      });
    }
    if (route === "/adversarial") {
      // The adversarial suite against ExecWard itself, where the sandbox is real (FR-31, Gate 1).
      const target = execwardTarget({ executor: dynamicWorkerExecutor(env.LOADER) });
      const cases = ADVERSARIAL_CASES.filter((item) => !JUDGED_FROM_THE_BUILD.includes(item.id));
      // Beside each verdict, how each script run ended: what stopped it, not only that it was stopped.
      const results = [];
      for (const item of cases) {
        const runs: { status: string; errorCode?: string }[] = [];
        const watched = {
          ...target,
          runScript: async (run: Parameters<NonNullable<typeof target.runScript>>[0]) => {
            const result = await target.runScript!(run);
            runs.push({ status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
            return result;
          },
        };
        results.push({ ...(await runSuite(watched, [item]))[0], runs });
      }
      return Response.json({ target: target.name, results });
    }
    if (route === "/fixture") {
      // The code tool over the invented GitHub, for the Code Mode arm of the eval (task 1.9.5).
      const body = (await request.json()) as { input?: unknown };
      const { backend, pins, records } = await fixture();
      const pinned = registry({ pins, current: async (path) => pins.find((pin) => pin.path === path)?.definition });
      const output = await runCodeTool(body.input, {
        executor: dynamicWorkerExecutor(env.LOADER),
        audit: auditLog(memoryAuditStore(), () => Date.now()),
        hostFor: () =>
          brokerHost({
            store: memoryPolicyStore(records),
            definitionFor: (record) => pinned.definitionFor(record),
            docsFor: (path) => pinned.docsFor(path),
            upstream: ({ record, args }) => backend.call(record.tool, args),
          }),
        allowedDataClass: () => "confidential",
        newRunId: () => crypto.randomUUID(),
        now: () => Date.now(),
      });
      return Response.json({ output });
    }
    if (route === "/github-app") {
      // Task 1.1.2: the GitHub App's signed statement, made in this runtime from a key the test
      // made for the purpose. Nothing is sent to GitHub.
      const body = (await request.json()) as { appId?: unknown; privateKeyPem?: unknown };
      try {
        if (typeof body.appId !== "string" || typeof body.privateKeyPem !== "string") throw new Error("missing");
        return Response.json({ jwt: await appJwt(body.appId, body.privateKeyPem, Date.now()) });
      } catch {
        return Response.json({ error: "not usable" }, { status: 400 });
      }
    }
    if (route === "/github") {
      // The GitHub connector behind the whole stack: code tool, sandbox, broker, pinned
      // definitions and policy. The credential is this Worker's secret GITHUB_TOKEN; when it
      // is not set, every call fails with "no credential".
      const body = (await request.json()) as GithubBody;
      const token = (): string | undefined => env.GITHUB_TOKEN;
      if (body.configured) return Response.json({ configured: typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN !== "" });
      if (body.writeProbe) {
        // Task 1.1.2: a write attempted with the credential must be refused by GitHub. The
        // write is the least visible one there is: a blob nothing points to. Only the
        // status comes back.
        const { owner, repo } = body.writeProbe;
        const held = token();
        if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !held) return Response.json({ error: "not usable" }, { status: 400 });
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          redirect: "manual",
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${held}`, "user-agent": "execward", "content-type": "application/json" },
          body: JSON.stringify({ content: "execward write probe", encoding: "utf-8" }),
        });
        return Response.json({ status: response.status });
      }
      const { pins, records } = await githubPinsAndPolicy();
      const pinned = registry({ pins, current: async (path) => pins.find((pin) => pin.path === path)?.definition });
      const output = await runCodeTool(body.input, {
        executor: dynamicWorkerExecutor(env.LOADER),
        audit: auditLog(memoryAuditStore(), () => Date.now()),
        hostFor: () =>
          brokerHost({
            store: memoryPolicyStore(records),
            definitionFor: (record) => pinned.definitionFor(record),
            docsFor: (path) => pinned.docsFor(path),
            // The guarded fetch: named hosts only, as production must use (task 1.1.6).
            upstream: githubUpstream({ token, fetch: outboundFetch() }),
          }),
        allowedDataClass: () => body.allowedDataClass ?? "confidential",
        newRunId: () => "github-run",
        now: () => Date.now(),
      });
      // Checked here, where the credential is known: it must be nowhere in what goes back.
      const held = token();
      return Response.json({ output, credentialInReply: held ? JSON.stringify(output).includes(held) : false });
    }
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
