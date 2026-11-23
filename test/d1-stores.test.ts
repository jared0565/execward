/**
 * The database-backed stores, on the local D1 database inside the local
 * Workers runtime, through the test-only Worker in ./workers/harness.ts.
 *
 * Local D1 is SQLite, as deployed D1 is, so the SQL is the same. What this
 * cannot show is behaviour under real concurrent Workers; the "all at once"
 * cases below run in one process.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { INITIAL_CONTROL_STATE, type ControlState } from "../src/console/control";
import { ESCALATION_MENU, type EscalationItem } from "../src/console/escalations";

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
  worker = await unstable_startWorker({ config: "test/workers/wrangler.jsonc", 
    // Its own local database folder: another test file uses the same Worker, and two processes on one SQLite file lock each other.
    dev: { server: { port: 0 }, inspector: false, logLevel: "error", persist: "test/workers/.wrangler/state-stores" },
  });
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
});

type Result = { value: unknown } | { error: string };
interface Reply {
  readonly results: Result[];
  readonly counters: { id: string; total: number }[];
}
type Op = [store: string, op: string, ...args: unknown[]];

async function stores(ops: readonly Op[], options: { together?: boolean; noTables?: boolean; rawSql?: string[] } = {}): Promise<Reply> {
  const response = await worker.fetch("http://harness.invalid/stores", {
    method: "POST",
    body: JSON.stringify({ ops: ops.map(([store, op, ...args]) => ({ store, op, args })), ...options }),
  });
  return (await response.json()) as Reply;
}
const values = (reply: Reply): unknown[] => reply.results.map((result) => ("value" in result ? result.value : `error: ${result.error}`));

const MINUTE = 60_000;
const T = 1_800_000_000_000;

describe("database-backed stores, on a local D1 database", { timeout: 30_000 }, () => {
  describe("quota counters (FR-27)", () => {
    it("adds to a counter and returns the running total", async () => {
      const reply = await stores([
        ["quota", "add", "runs:work", MINUTE, 1, T],
        ["quota", "add", "runs:work", MINUTE, 1, T + 1_000],
        ["quota", "add", "runs:work", MINUTE, 5, T + 2_000],
      ]);
      expect(values(reply)).toEqual([1, 2, 7]);
    });

    it("starts a new count in each window, and keeps keys and window sizes apart", async () => {
      const startOfWindow = Math.ceil(T / MINUTE) * MINUTE;
      const reply = await stores([
        ["quota", "add", "runs:work", MINUTE, 1, startOfWindow],
        ["quota", "add", "runs:work", MINUTE, 1, startOfWindow + MINUTE - 1],
        ["quota", "add", "runs:work", MINUTE, 1, startOfWindow + MINUTE],
        ["quota", "add", "runs:other", MINUTE, 1, startOfWindow],
        ["quota", "add", "runs:work", 24 * 60 * MINUTE, 1, startOfWindow],
      ]);
      expect(values(reply)).toEqual([1, 2, 1, 1, 1]);
      expect(reply.counters.length).toBe(4);
    });

    it("loses no count when twenty adds arrive at once", async () => {
      const ops: Op[] = Array.from({ length: 20 }, () => ["quota", "add", "runs:work", MINUTE, 1, T]);
      const reply = await stores(ops, { together: true });
      expect((values(reply) as number[]).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
      expect(reply.counters).toMatchObject([{ total: 20 }]);
    });

    it("sweeps counters whose window has ended, and only those", async () => {
      const reply = await stores([
        ["quota", "add", "runs:work", MINUTE, 1, T],
        ["quota", "add", "runs:work", 24 * 60 * MINUTE, 1, T],
        ["sweep", "counters", T + 2 * MINUTE],
      ]);
      expect(reply.counters.map((counter) => counter.id.split("@")[1]?.split(":")[0])).toEqual(["86400000"]);
    });

    it("fails, so that the caller refuses the run, when the table is missing", async () => {
      const reply = await stores([["quota", "add", "runs:work", MINUTE, 1, T], ["quota", "acquire", "running:work", "run-1", 2, MINUTE, T]], { noTables: true });
      expect(reply.results.every((result) => "error" in result)).toBe(true);
    });
  });

  describe("concurrent-run slots (FR-27)", () => {
    it("gives out as many slots as the limit and no more", async () => {
      const reply = await stores([
        ["quota", "acquire", "running:work", "run-1", 2, MINUTE, T],
        ["quota", "acquire", "running:work", "run-2", 2, MINUTE, T],
        ["quota", "acquire", "running:work", "run-3", 2, MINUTE, T],
        ["quota", "acquire", "running:other", "run-4", 2, MINUTE, T],
      ]);
      expect(values(reply)).toEqual([true, true, false, true]);
    });

    it("frees a slot on release, and on its own after its time is up", async () => {
      const reply = await stores([
        ["quota", "acquire", "running:work", "run-1", 1, MINUTE, T],
        ["quota", "acquire", "running:work", "run-2", 1, MINUTE, T],
        ["quota", "release", "running:work", "run-1"],
        ["quota", "acquire", "running:work", "run-2", 1, MINUTE, T],
        // run-2 never releases. Its slot lapses a minute later.
        ["quota", "acquire", "running:work", "run-3", 1, MINUTE, T + MINUTE - 1],
        ["quota", "acquire", "running:work", "run-3", 1, MINUTE, T + MINUTE],
      ]);
      expect(values(reply)).toEqual([true, false, null, true, false, true]);
    });

    it("never gives out more than the limit when ten runs ask at once", async () => {
      const ops: Op[] = Array.from({ length: 10 }, (_, n) => ["quota", "acquire", "running:work", `run-${n}`, 3, MINUTE, T]);
      const reply = await stores(ops, { together: true });
      expect(values(reply).filter((taken) => taken === true).length).toBe(3);
    });
  });

  describe("the owner's switches (FR-16, FR-27)", () => {
    const on: ControlState = { ...INITIAL_CONTROL_STATE, codeMode: true, version: 1 };

    it("reads everything as off when nothing has been written", async () => {
      expect(values(await stores([["control", "read"]]))).toEqual([INITIAL_CONTROL_STATE]);
    });

    it("writes a change and reads it back", async () => {
      const killed: ControlState = { ...on, killed: true, pausedProjects: ["work"], blockedTools: ["github_get_file"], version: 2 };
      const reply = await stores([["control", "write", on, 0], ["control", "read"], ["control", "write", killed, 1], ["control", "read"]]);
      expect(values(reply)).toEqual([true, on, true, killed]);
    });

    it("refuses a write made from a stale read", async () => {
      const reply = await stores([
        ["control", "write", on, 0],
        // A second first-write, and a write that names a version that is no longer current.
        ["control", "write", { ...on, killed: true }, 0],
        ["control", "write", { ...on, version: 3 }, 2],
        ["control", "read"],
      ]);
      expect(values(reply)).toEqual([true, false, false, on]);
    });

    it("lets exactly one of five writers win when they all start from the same read", async () => {
      const ops: Op[] = Array.from({ length: 5 }, (_, n) => ["control", "write", { ...on, pausedProjects: [`project-${n}`] }, 0]);
      const reply = await stores(ops, { together: true });
      expect(values(reply).filter((won) => won === true).length).toBe(1);
    });

    it("fails, so that every reader fails closed, on a state it cannot understand or a missing table", async () => {
      const corrupt = await stores([["control", "read"]], { rawSql: [`INSERT INTO control_state (id, version, state) VALUES (1, 4, '{"codeMode":"yes"}')`] });
      expect(values(corrupt)).toEqual(["error: the stored control state is not valid"]);
      const missing = await stores([["control", "read"]], { noTables: true });
      expect("error" in missing.results[0]!).toBe(true);
    });

    it("allows only one row", async () => {
      // The database itself refuses a second row; the request fails with its error.
      const attempt = worker
        .fetch("http://harness.invalid/stores", { method: "POST", body: JSON.stringify({ ops: [], rawSql: [`INSERT INTO control_state (id, version, state) VALUES (2, 1, '{}')`] }) })
        .then(async (response) => (response.ok ? "accepted" : await response.text()));
      await expect(attempt.catch((error: Error) => error.message)).resolves.toContain("CHECK constraint failed");
    });
  });

  describe("the escalation queue (FR-44)", () => {
    const item = (id: string, createdAt: number, status: EscalationItem["status"] = "open"): EscalationItem => ({
      id,
      trigger: "security_exception",
      project: "work",
      createdAt,
      urgent: true,
      status,
      runId: "run-7",
      error: { code: "policy_denied", message: "a call was refused: the tool has no policy record" },
      context: { toolPath: "github_get_file" },
      options: ESCALATION_MENU.security_exception.options,
      recommended: { optionId: "keep_paused", rule: "Keep paused, always. A false positive is never recommended." },
      safeAction: "Project paused at once",
      expiresAt: null,
    });

    it("stores an item whole and reads it back", async () => {
      const first = item("k3Jx9QpLm2Zt7VbN4wRs", T);
      const reply = await stores([["escalations", "put", first], ["escalations", "get", first.id], ["escalations", "get", "no-such-item"]]);
      expect(values(reply)).toEqual([null, first, null]);
    });

    it("replaces an item when it changes, and lists items oldest first", async () => {
      const older = item("aaaaaaaaaaaaaaaaaaaa", T);
      const newer = item("bbbbbbbbbbbbbbbbbbbb", T + 1_000);
      const resolved: EscalationItem = { ...older, status: "resolved", resolution: { optionId: "false_positive", by: "owner", at: T + 5_000, reason: "reviewed" } };
      const reply = await stores([["escalations", "put", newer], ["escalations", "put", older], ["escalations", "put", resolved], ["escalations", "all"]]);
      expect(values(reply)[3]).toEqual([resolved, newer]);
    });
  });

  describe("project records (FR-32)", () => {
    it("stores a project's data class, and reads a project with no record as absent", async () => {
      const reply = await stores([
        ["projects", "put", { project: "work", dataClass: "internal" }],
        ["projects", "get", "work"],
        ["projects", "get", "never-set-up"],
        ["projects", "put", { project: "work", dataClass: "confidential" }],
        ["projects", "get", "work"],
      ]);
      expect(values(reply)).toEqual([null, { project: "work", dataClass: "internal" }, null, null, { project: "work", dataClass: "confidential" }]);
    });

    it("refuses to set a project to client personal data while the gate is uncleared", async () => {
      const reply = await stores([
        ["projects", "put", { project: "acme", dataClass: "client_personal" }],
        ["projects", "get", "acme"],
        ["projects", "put", { project: "acme", dataClass: "client_personal" }, { cleared: true }],
        ["projects", "get", "acme"],
      ]);
      expect(values(reply)).toEqual([
        'error: the project "acme" cannot be set to client personal data until gate G.7 is cleared',
        null,
        null,
        { project: "acme", dataClass: "client_personal" },
      ]);
    });

    it("fails on a data class it does not know", async () => {
      const reply = await stores([["projects", "get", "work"]], { rawSql: [`INSERT INTO projects (project, data_class) VALUES ('work', 'everything')`] });
      expect(values(reply)).toEqual(["error: the project's record holds an unknown data class"]);
    });
  });
});

describe("backup to a bucket and restore (task 1.4.5)", { timeout: 120_000 }, () => {
  const NOW = Date.UTC(2027, 0, 15, 12);
  interface BackupReply {
    readonly taken: { key: string; rows: Record<string, number>; bytes: number; sha256: string; pruned: number };
    readonly keys: string[];
    readonly restored: { rows: Record<string, number> } | { error: string };
    readonly sameAuditLog: boolean;
    readonly chain: { ok: boolean };
    readonly control: unknown;
    readonly policyPaths: string[];
    readonly project: unknown;
    readonly escalations: number;
  }
  async function backup(body: Record<string, unknown> = {}): Promise<BackupReply> {
    const response = await worker.fetch("http://harness.invalid/backup", { method: "POST", body: JSON.stringify({ now: NOW, ...body }) });
    return (await response.json()) as BackupReply;
  }

  it("backs up every table, and a restore into an empty database gives the same content back", async () => {
    const reply = await backup();
    expect(reply.taken.key).toBe("backups/2027-01-15.json");
    expect(reply.taken.rows).toMatchObject({ policy: 3, audit_log: 5, escalations: 1, control_state: 1, projects: 1 });
    expect(reply.taken.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reply.keys).toEqual(["backups/2027-01-15.json"]);
    expect(reply.restored).toEqual({ rows: reply.taken.rows });
    // The audit log comes back entry for entry, and its hash chain still verifies.
    expect(reply.sameAuditLog).toBe(true);
    expect(reply.chain).toMatchObject({ ok: true });
    expect(reply.control).toMatchObject({ codeMode: true, pausedProjects: ["paused-one"], version: 1 });
    expect(reply.policyPaths.length).toBe(3);
    expect(reply.project).toEqual({ project: "work", dataClass: "internal" });
    expect(reply.escalations).toBe(1);
  });

  it("backs up a table larger than one page of rows", async () => {
    const reply = await backup({ auditEvents: 1_100 });
    expect(reply.taken.rows.audit_log).toBe(1_100);
    expect(reply.restored).toEqual({ rows: reply.taken.rows });
    expect(reply.sameAuditLog).toBe(true);
    expect(reply.chain).toMatchObject({ ok: true });
  });

  it("deletes backups older than seven days, and nothing else", async () => {
    const reply = await backup({ olderObjects: ["backups/2027-01-01.json", "backups/2027-01-08.json", "backups/2027-01-09.json", "backups/2027-01-14.json", "backups/notes.txt", "backups/2020-01-01.json.bak"] });
    expect(reply.taken.pruned).toBe(2);
    expect(reply.keys).toEqual(["backups/2020-01-01.json.bak", "backups/2027-01-09.json", "backups/2027-01-14.json", "backups/2027-01-15.json", "backups/notes.txt"]);
  });

  it("refuses to restore a backup that was changed after it was written, and writes nothing", async () => {
    const reply = await backup({ tamperBackup: true });
    expect(reply.restored).toEqual({ error: "BackupError: the backup does not match its recorded hash" });
    expect(reply.escalations).toBe(0);
    expect(reply.policyPaths).toEqual([]);
  });

  it("refuses a backup that is not there, and refuses to restore over rows that exist", async () => {
    expect((await backup({ restoreKey: "backups/1999-01-01.json" })).restored).toEqual({ error: 'BackupError: there is no backup named "backups/1999-01-01.json"' });
    expect((await backup({ restoreTwice: true })).restored).toEqual({ error: 'BackupError: the table "policy" is not empty' });
  });
});

describe("the production Worker's timer (tasks 1.4.4, 1.4.5, 1.6.8)", { timeout: 120_000 }, () => {
  const DAY = 86_400_000;
  const MORNING = Date.UTC(2027, 0, 15, 0, 5);
  interface TimerReply {
    readonly runs: { frequent: { job: string; ok: boolean; detail: string }[]; daily?: { job: string; ok: boolean; detail: string }[]; backup?: { key?: string; error?: string; rows?: Record<string, number> } }[];
    readonly keys: string[];
    readonly kinds: string[];
    readonly oldTextRemoved: boolean;
    readonly chain: { ok: boolean };
    readonly escalationStatuses: string[];
  }
  async function timer(body: Record<string, unknown>): Promise<TimerReply> {
    const response = await worker.fetch("http://harness.invalid/scheduled", { method: "POST", body: JSON.stringify(body) });
    return (await response.json()) as TimerReply;
  }

  it("does the daily round once a day, at the first firing, and only the frequent round after that", async () => {
    const reply = await timer({ times: [MORNING, MORNING + 5 * 60_000, MORNING + 10 * 60_000, MORNING + DAY] });
    expect(reply.runs.map((run) => run.daily !== undefined)).toEqual([true, false, false, true]);
    expect(reply.runs[0]?.daily?.map((job) => job.job)).toEqual(["apply_retention", "sweep_counters"]);
    expect(reply.runs[0]?.backup).toMatchObject({ key: "backups/2027-01-15.json" });
    expect(reply.keys).toEqual(["backups/2027-01-15.json", "backups/2027-01-16.json"]);
    // Each daily round is recorded. A frequent round that did nothing is not.
    expect(reply.kinds).toEqual(["maintenance", "maintenance"]);
    expect(reply.chain).toMatchObject({ ok: true });
  });

  it("applies retention and closes an expired escalation, and records what it did", async () => {
    const reply = await timer({ times: [MORNING], oldEntryDays: 8, expiredEscalation: true });
    expect(reply.runs[0]?.frequent).toEqual([{ job: "expire_escalations", ok: true, detail: "1 closed" }]);
    expect(reply.runs[0]?.daily?.[0]).toMatchObject({ job: "apply_retention", ok: true });
    expect(reply.oldTextRemoved).toBe(true);
    expect(reply.escalationStatuses).toEqual(["expired"]);
    expect(reply.kinds.at(-1)).toBe("maintenance");
    expect(reply.chain).toMatchObject({ ok: true });
  });

  it("tries the daily round again at the next firing when the backup failed", async () => {
    const reply = await timer({ times: [MORNING, MORNING + 5 * 60_000], brokenBucket: true });
    expect(reply.runs.map((run) => run.backup)).toEqual([{ error: "the bucket refused the write" }, { error: "the bucket refused the write" }]);
    expect(reply.keys).toEqual([]);
    expect(reply.kinds).toEqual(["maintenance", "maintenance"]);
  });
});

describe("the code tool as production will serve it, with every store on the database (task 1.9.4)", { timeout: 120_000 }, () => {
  async function service(body: Record<string, unknown>): Promise<{ ready?: number; output?: { status: string; result?: unknown; error?: { code: string; message: string } }; auditEntries?: number; chain?: { ok: boolean } }> {
    const response = await worker.fetch("http://harness.invalid/service", { method: "POST", body: JSON.stringify(body) });
    return (await response.json()) as never;
  }

  it("runs a script that calls a tool, and writes the run to the audit log", async () => {
    expect(await service({ setup: true })).toEqual({ ready: 15 });
    const reply = await service({ verify: true, input: { project: "eval", script: `const repo = await tools.github_get_repository({ owner: "northwind-labs", repo: "web-dashboard" });\nreturn repo.name;` } });
    expect(reply.output?.error).toBeUndefined();
    expect(reply.output).toMatchObject({ status: "completed", result: "web-dashboard" });
    // Started and finished.
    expect(reply.auditEntries).toBe(2);
    expect(reply.chain).toMatchObject({ ok: true });
  });

  it("runs nothing until the owner has switched Code Mode on", async () => {
    await service({ setup: true, codeMode: false });
    const reply = await service({ input: { project: "eval", script: "return 1;" } });
    expect(reply.output).toMatchObject({ status: "refused", error: { code: "code_mode_off" } });
  });

  it("treats a project with no record as public: it may run, and may not call a tool above that class", async () => {
    await service({ setup: true });
    expect((await service({ input: { project: "unknown-project", script: "return 1;" } })).output).toMatchObject({ status: "completed", result: 1 });
    const reply = await service({ input: { project: "unknown-project", script: `return await tools.github_get_repository({ owner: "northwind-labs", repo: "web-dashboard" });` } });
    expect(reply.output).toMatchObject({ status: "error", error: { code: "policy_denied" } });
  });
});
