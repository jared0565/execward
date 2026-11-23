import { describe, expect, it } from "vitest";
import { fakeToken } from "../src/adversarial/fixtures";
import {
  applyRetention,
  auditLog,
  AuditLogError,
  deleteProjectLogs,
  GENESIS_HASH,
  memoryAuditStore,
  verifyChain,
  type AuditEntry,
  type AuditLog,
  type AuditStore,
} from "../src/audit/log";
import { RETENTION } from "../src/limits";
import { redact, redactText } from "../src/audit/redact";
import { brokerHost } from "../src/broker/broker";
import { memoryPolicyStore } from "../src/broker/policy-store";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import type { Executor } from "../src/executor";
import { record } from "./fixtures/policy";

const event = (n: number, body: unknown = { n }) => ({ kind: "test", runId: `run-${n}`, project: "demo", body });

async function logOf(count: number) {
  const store = memoryAuditStore();
  const log = auditLog(store, () => 1_700_000_000_000);
  for (let n = 1; n <= count; n++) await log.record(event(n));
  return { store, log };
}

describe("the audit log is a hash chain (FR-28)", () => {
  it("numbers entries from 1 and links each to the one before", async () => {
    const { store } = await logOf(3);
    expect(store.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(store.entries[0]?.prevHash).toBe(GENESIS_HASH);
    expect(store.entries[1]?.prevHash).toBe(store.entries[0]?.hash);
    expect(store.entries[2]?.prevHash).toBe(store.entries[1]?.hash);
    expect(store.entries[0]).toMatchObject({ at: "2023-11-14T22:13:20.000Z", kind: "test", runId: "run-1", project: "demo", content: '{"n":1}' });
    expect(await verifyChain(store.entries)).toEqual({ ok: true, entries: 3 });
    expect(await verifyChain([])).toEqual({ ok: true, entries: 0 });
  });

  const tampering: [string, (entries: AuditEntry[]) => AuditEntry[], number][] = [
    ["an edited content", (e) => e.map((x) => (x.seq === 2 ? { ...x, content: '{"n":999}' } : x)), 2],
    ["an edited project", (e) => e.map((x) => (x.seq === 2 ? { ...x, project: "other" } : x)), 2],
    ["an edited time", (e) => e.map((x) => (x.seq === 3 ? { ...x, at: "2020-01-01T00:00:00.000Z" } : x)), 3],
    ["an edited kind", (e) => e.map((x) => (x.seq === 1 ? { ...x, kind: "harmless" } : x)), 1],
    ["a removed entry", (e) => e.filter((x) => x.seq !== 2), 3],
    ["a removed first entry", (e) => e.slice(1), 2],
    ["entries in another order", (e) => [e[0]!, e[2]!, e[1]!, e[3]!], 3],
    ["a renumbered entry", (e) => e.map((x) => (x.seq === 4 ? { ...x, seq: 5 } : x)), 5],
  ];
  it.each(tampering)("fails verification after %s, and says where", async (_label, tamper, at) => {
    const { store } = await logOf(4);
    const check = await verifyChain(tamper([...store.entries]));
    expect(check).toMatchObject({ ok: false, seq: at });
  });

  it("fails verification when an entry is rewritten together with its own hashes", async () => {
    // The attacker recomputes entry 2 properly. Entry 3 still points at the old hash.
    const { store } = await logOf(3);
    const forged = memoryAuditStore();
    const forger = auditLog(forged, () => 1_700_000_000_000);
    await forger.record(event(1));
    await forger.record(event(2, { n: "forged" }));
    const check = await verifyChain([store.entries[0]!, forged.entries[1]!, store.entries[2]!]);
    expect(check).toEqual({ ok: false, seq: 3, reason: "does not follow the entry before it" });
  });

  it("cannot detect entries cut from the end: that needs the latest hash kept elsewhere", async () => {
    const { store } = await logOf(4);
    expect(await verifyChain(store.entries.slice(0, 2))).toEqual({ ok: true, entries: 2 });
  });

  it("still verifies after an entry's content is removed, as retention will do", async () => {
    const { store } = await logOf(3);
    const expired = store.entries.map((entry) => (entry.seq === 2 ? { ...entry, content: null } : entry));
    expect(await verifyChain(expired)).toEqual({ ok: true, entries: 3 });
  });

  it("retries when another writer takes the position first, and gives up cleanly", async () => {
    const real = memoryAuditStore();
    let clashes = 2;
    const racing: AuditStore = { ...real, insert: async (entry) => (clashes-- > 0 ? false : real.insert(entry)) };
    await auditLog(racing, () => 0).record(event(1));
    expect(real.entries.length).toBe(1);

    const jammed: AuditStore = { ...real, insert: async () => false };
    await expect(auditLog(jammed, () => 0).record(event(2))).rejects.toThrow(AuditLogError);
  });

  it("reports a store failure as an audit log error", async () => {
    const down: AuditStore = { ...memoryAuditStore(), last: async () => Promise.reject(new Error("disk full")) };
    await expect(auditLog(down, () => 0).record(event(1))).rejects.toThrow("the audit log could not be written: disk full");
  });

  it("stores control characters escaped, so a logged value cannot forge a line or drive a terminal", async () => {
    const store = memoryAuditStore();
    const hostile = `ok\n{"seq":99,"kind":"forged"}\r${String.fromCharCode(27)}[2J${String.fromCharCode(0)}${String.fromCharCode(0x7f)}${String.fromCharCode(0x9b)}${String.fromCharCode(0x2028)}end`;
    await auditLog(store, () => 0).record(event(1, { text: hostile }));
    const content = store.entries[0]?.content ?? "";
    for (const char of content) {
      const code = char.charCodeAt(0);
      expect(code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) && code !== 0x2028, `character ${code}`).toBe(true);
    }
    expect(JSON.parse(content)).toEqual({ text: hostile });
  });
});

describe("retention (FR-21)", () => {
  const DAY = 86_400_000;
  const NOW = 1_800_000_000_000;

  /** Writes one entry per item, each `ageDays` old. */
  async function aged(items: readonly { ageDays: number; runId?: string; project?: string; security?: boolean }[]) {
    const store = memoryAuditStore();
    let at = NOW;
    const log = auditLog(store, () => at);
    for (const [index, item] of items.entries()) {
      at = NOW - item.ageDays * DAY;
      await log.record({ kind: "test", runId: item.runId ?? `run-${index}`, project: item.project ?? "demo", security: item.security === true, body: { text: `full text ${index}` } });
    }
    const verify = async () => verifyChain(store.entries, await store.anchor());
    return { store, log, verify };
  }

  it("keeps full text for 7 days and whole entries for 90", () => {
    expect(RETENTION).toEqual({ fullTextDays: 7, recordDays: 90 });
  });

  it("removes full text after 7 days, keeps the entry, and the chain still verifies", async () => {
    const { store, verify } = await aged([{ ageDays: 30 }, { ageDays: 7.01 }, { ageDays: 6.99 }, { ageDays: 0 }]);
    expect(await applyRetention(store, NOW)).toEqual({ contentExpired: 2, entriesRemoved: 0 });
    expect(store.entries.map((entry) => entry.content === null)).toEqual([true, true, false, false]);
    expect(store.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(await verify()).toEqual({ ok: true, entries: 4 });
    // Running it again changes nothing.
    expect(await applyRetention(store, NOW)).toEqual({ contentExpired: 0, entriesRemoved: 0 });
  });

  it("removes whole entries after 90 days, and the chain verifies from where the log now starts", async () => {
    const { store, verify } = await aged([{ ageDays: 200 }, { ageDays: 91 }, { ageDays: 89 }, { ageDays: 1 }]);
    const second = store.entries[1]!;
    expect(await applyRetention(store, NOW)).toEqual({ contentExpired: 1, entriesRemoved: 2 });
    expect(store.entries.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(await store.anchor()).toEqual({ seq: second.seq, hash: second.hash });
    expect(await verify()).toEqual({ ok: true, entries: 2 });
    // Without the anchor the shortened log does not verify: the start cannot be faked.
    expect(await verifyChain(store.entries)).toMatchObject({ ok: false, seq: 3 });
  });

  it("keeps numbering after everything has been removed", async () => {
    const { store, log, verify } = await aged([{ ageDays: 100 }, { ageDays: 95 }]);
    await applyRetention(store, NOW);
    expect(store.entries).toEqual([]);
    await log.record({ kind: "test", runId: "new", project: "demo", body: {} });
    expect(store.entries.map((entry) => entry.seq)).toEqual([3]);
    expect(await verify()).toEqual({ ok: true, entries: 1 });
  });

  it("keeps the full text of a whole run for 90 days when the run included a security event", async () => {
    const { store, verify } = await aged([
      { ageDays: 30, runId: "bad-run" },
      { ageDays: 30, runId: "bad-run", security: true },
      { ageDays: 30, runId: "ordinary-run" },
      { ageDays: 95, runId: "old-bad-run", security: true },
    ]);
    // Entries are written in the order given, so the 95-day one is last; nothing is removed from the front.
    expect(await applyRetention(store, NOW)).toEqual({ contentExpired: 1, entriesRemoved: 0 });
    expect(store.entries.map((entry) => [entry.runId, entry.content === null])).toEqual([
      ["bad-run", false],
      ["bad-run", false],
      ["ordinary-run", true],
      ["old-bad-run", false],
    ]);
    expect(await verify()).toEqual({ ok: true, entries: 4 });
  });

  it("removes a security event with everything else once it is 90 days old", async () => {
    const { store } = await aged([{ ageDays: 91, security: true }, { ageDays: 1 }]);
    expect(await applyRetention(store, NOW)).toMatchObject({ entriesRemoved: 1 });
    expect(store.entries.map((entry) => entry.seq)).toEqual([2]);
  });

  it("deletes one project's logs on request, records the deletion, and the chain still verifies", async () => {
    const { store, log, verify } = await aged([
      { ageDays: 2, project: "acme" },
      { ageDays: 2, project: "other" },
      { ageDays: 1, project: "acme", security: true },
    ]);
    expect(await deleteProjectLogs(store, log, "acme")).toBe(2);
    expect(store.entries.map((entry) => [entry.project, entry.kind, entry.content])).toEqual([
      ["acme", "test", null],
      ["other", "test", '{"text":"full text 1"}'],
      ["acme", "test", null],
      ["acme", "project_logs_deleted", '{"entriesErased":2}'],
    ]);
    expect(await verify()).toEqual({ ok: true, entries: 4 });
  });

  it("still detects tampering after content has been removed", async () => {
    const { store, verify } = await aged([{ ageDays: 30 }, { ageDays: 30 }, { ageDays: 0 }]);
    await applyRetention(store, NOW);
    store.entries[0] = { ...store.entries[0]!, project: "someone-else" };
    expect(await verify()).toMatchObject({ ok: false, seq: 1 });
  });

  it("tolerates a removal that was interrupted after the anchor moved", async () => {
    const { store } = await aged([{ ageDays: 100 }, { ageDays: 1 }]);
    const first = store.entries[0]!;
    expect(await verifyChain(store.entries, { seq: first.seq, hash: first.hash })).toEqual({ ok: true, entries: 1 });
  });
});

describe("secrets are redacted before writing (FR-21)", () => {
  const token = fakeToken();

  it("replaces a known secret shape wherever it appears in text", () => {
    expect(redactText(`curl -H "Authorization: Bearer ${token}" https://api.github.com`)).toBe(
      'curl -H "Authorization: Bearer [redacted: a GitHub token]" https://api.github.com',
    );
    expect(redactText(`${token} and again ${token}`)).toBe("[redacted: a GitHub token] and again [redacted: a GitHub token]");
    expect(redactText("nothing secret here")).toBe("nothing secret here");
  });

  it("replaces the value of a field whose name says it holds a secret, whatever the value looks like", () => {
    expect(
      redact({ Authorization: "Basic dXNlcjpwYXNz", password: "hunter2", api_key: "k", apiKey: "k", "client-secret": "s", nested: { token: 12345, keep: "visible" }, list: [{ cookie: "a=b" }] }),
    ).toEqual({
      Authorization: "[redacted]",
      password: "[redacted]",
      api_key: "[redacted]",
      apiKey: "[redacted]",
      "client-secret": "[redacted]",
      nested: { token: "[redacted]", keep: "visible" },
      list: [{ cookie: "[redacted]" }],
    });
  });

  it("does not change the value it was given, or ordinary data", () => {
    const original = { note: token, count: 3, ok: true, none: null };
    const copy = redact(original);
    expect(original.note).toBe(token);
    expect(copy).toEqual({ note: "[redacted: a GitHub token]", count: 3, ok: true, none: null });
    expect(redact({ tokens_used: 5, author: "sam", secretary: "kim" })).toEqual({ tokens_used: 5, author: "sam", secretary: "kim" });
  });

  it("stores a known secret in call arguments redacted", async () => {
    const store = memoryAuditStore();
    await auditLog(store, () => 0).record(event(1, { calls: [{ path: "github_get_file", args: { path: "docs/a.md", token, headers: { note: `key ${token}` } } }] }));
    const content = store.entries[0]?.content ?? "";
    expect(content).not.toContain(token);
    expect(JSON.parse(content)).toEqual({ calls: [{ path: "github_get_file", args: { path: "docs/a.md", token: "[redacted]", headers: { note: "key [redacted: a GitHub token]" } } }] });
  });
});

describe("every run is logged, always (FR-8)", () => {
  const completed = (result: unknown): Executor => ({
    name: "scripted",
    async execute(request) {
      await request.host.callTool("github_list_issues", { state: "open" });
      await request.host.callTool("github_delete_repo", {}).catch(() => undefined);
      return { status: "completed", result, logs: [], truncated: false };
    },
  });
  const quiet: Executor = { name: "scripted", execute: async () => ({ status: "completed", result: [1, 2, 3], logs: [], truncated: false }) };
  const plainHost: RunHost = { callTool: async () => ({ items: [1, 2] }), search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass: undefined, records: 0 }) };

  function setup(executor: Executor, host: RunHost = plainHost, audit?: AuditLog) {
    const store = memoryAuditStore();
    let clock = 0;
    const deps = { executor, audit: audit ?? auditLog(store, () => 0), hostFor: () => host, newRunId: () => "run-1", now: () => (clock += 10) };
    const contents = () => store.entries.map((entry) => ({ kind: entry.kind, runId: entry.runId, project: entry.project, ...(JSON.parse(entry.content ?? "{}") as Record<string, unknown>) }));
    return { deps, store, contents };
  }

  it("records the script, each call with its arguments and result size, the duration and the outcome", async () => {
    const { deps, store, contents } = setup(completed({ open: 2 }));
    const output = await runCodeTool({ script: "return 1;", project: "demo", intent: "count issues" }, deps);
    expect(output.status).toBe("completed");
    const [started, finished] = contents();
    expect(started).toMatchObject({ kind: "run_started", runId: "run-1", project: "demo", script: "return 1;", scriptHash: output.report.scriptHash, executor: "scripted", intent: "count issues" });
    expect(finished).toMatchObject({
      kind: "run_finished",
      runId: "run-1",
      status: "completed",
      security: false,
      resultBytes: 10,
      durationMs: output.report.durationMs,
      calls: [
        { path: "github_list_issues", args: { state: "open" }, outcome: "ok", resultBytes: 15 },
        { path: "github_delete_repo", args: {}, outcome: "ok", resultBytes: 15 },
      ],
    });
    expect(await verifyChain(store.entries)).toEqual({ ok: true, entries: 2 });
  });

  it("records a refused call with the code it was refused with, and marks the run as a security event", async () => {
    const host = brokerHost({
      store: memoryPolicyStore([record("list_issues"), record("delete_repo", { callerRule: "direct" })]),
      upstream: async () => [1],
      definitionFor: async () => ({ description: "t", inputSchema: { type: "object", additionalProperties: true } }),
    });
    const { deps, contents } = setup(completed("carried on"), host);
    const output = await runCodeTool({ script: "return 1;", project: "demo" }, deps);
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied" } });
    expect(contents()[1]).toMatchObject({
      kind: "run_finished",
      status: "error",
      security: true,
      error: { code: "policy_denied" },
      calls: [
        { path: "github_list_issues", outcome: "ok", resultBytes: 3 },
        { path: "github_delete_repo", outcome: "policy_denied", resultBytes: 0 },
      ],
    });
  });

  it("records a script refused by the static check, with its text redacted", async () => {
    const token = fakeToken();
    const { deps, contents, store } = setup(quiet);
    const output = await runCodeTool({ script: `return "${token}";`, project: "demo" }, deps);
    expect(output.status).toBe("refused");
    expect(contents()).toEqual([
      {
        kind: "run_refused",
        runId: "run-1",
        project: "demo",
        scriptHash: output.report.scriptHash,
        script: 'return "[redacted: a GitHub token]";',
        error: { code: "static_check_failed", message: "the script contains what looks like a GitHub token", line: 1 },
        security: true,
        report: output.report,
      },
    ]);
    expect(JSON.stringify(store.entries)).not.toContain(token);
  });

  it("records input that is not even a valid request", async () => {
    const { deps, contents } = setup(quiet);
    await runCodeTool("not an object", deps);
    expect(contents()).toMatchObject([{ kind: "run_refused", project: "unknown", script: null, error: { code: "schema_invalid" }, security: false }]);
  });

  it("logs large arguments as a size, not in full", async () => {
    const big: Executor = {
      name: "scripted",
      async execute(request) {
        await request.host.callTool("github_list_issues", { q: "x".repeat(10_000) });
        return { status: "completed", result: 1, logs: [], truncated: false };
      },
    };
    const { deps, contents } = setup(big);
    await runCodeTool({ script: "return 1;", project: "demo" }, deps);
    expect(contents()[1]).toMatchObject({ calls: [{ args: "[10008 bytes of arguments, not logged in full]" }] });
  });

  it("does not start a run it cannot record", async () => {
    let executed = 0;
    const counting: Executor = { name: "scripted", execute: async () => (executed++, { status: "completed", result: 1, logs: [], truncated: false }) };
    const down: AuditLog = { record: async () => Promise.reject(new AuditLogError("down")) };
    const { deps } = setup(counting, plainHost, down);
    const output = await runCodeTool({ script: "return 1;", project: "demo" }, deps);
    expect(output).toMatchObject({ status: "refused", error: { code: "policy_denied", message: "the audit log is unavailable, so the run was not started" } });
    expect(executed).toBe(0);
  });

  it("withholds a result it cannot record", async () => {
    const store = memoryAuditStore();
    const real = auditLog(store, () => 0);
    const failsAtTheEnd: AuditLog = { record: async (e) => (e.kind === "run_finished" ? Promise.reject(new AuditLogError("down")) : real.record(e)) };
    const { deps } = setup(completed("the answer"), plainHost, failsAtTheEnd);
    const output = await runCodeTool({ script: "return 1;", project: "demo" }, deps);
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied", message: "the audit log is unavailable, so the result is withheld" } });
    expect(JSON.stringify(output)).not.toContain("the answer");
  });

  it("records an executor that failed", async () => {
    const broken: Executor = { name: "scripted", execute: async () => Promise.reject(new Error("isolate lost")) };
    const { deps, contents } = setup(broken);
    await runCodeTool({ script: "return 1;", project: "demo" }, deps);
    expect(contents()[1]).toMatchObject({ kind: "run_finished", status: "error", error: { code: "sandbox_fault" }, calls: [] });
  });
});
