import { describe, expect, it } from "vitest";
import { ERASE_ACTOR, EraseRefused, eraseProjectRecords } from "../src/audit/erase";
import { auditLog, memoryAuditStore, verifyChain } from "../src/audit/log";
import { INITIAL_CONTROL_STATE, memoryControlStore } from "../src/console/control";
import { escalationQueue, memoryEscalationStore } from "../src/console/escalations";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 27, 9);
const SECRET_FIGURE = "41250.75";

function setup() {
  let now = START;
  let ids = 0;
  const audit = memoryAuditStore();
  const log = auditLog(audit, () => now);
  const escalations = memoryEscalationStore();
  const queue = escalationQueue({ store: escalations, control: memoryControlStore({ ...INITIAL_CONTROL_STATE, codeMode: true }), audit: log, now: () => now, newId: () => `item${String(++ids).padStart(4, "0")}aBcDeFgHiJkLmN` });
  return { deps: { audit, log, escalations }, audit, log, escalations, queue, advance: (ms: number) => (now += ms) };
}

describe("deleting one project's records on request (FR-21, the client notice)", () => {
  it("removes the text of the project's log entries and its closed queue items, leaves other projects alone, and records it", async () => {
    const { deps, audit, log, escalations, queue, advance } = setup();
    await log.record({ kind: "run_started", runId: "run-1", project: "acme", body: { script: `total = ${SECRET_FIGURE}` } });
    await log.record({ kind: "run_started", runId: "run-2", project: "other", body: { script: "kept" } });
    await queue.raise({ trigger: "repeated_failure", project: "acme", runId: "run-1", error: { code: "script_error", message: `expected ${SECRET_FIGURE}` } });
    const kept = await queue.raise({ trigger: "repeated_failure", project: "other", runId: "run-2" });
    // Both run out of time and are closed.
    advance(5 * HOUR);
    await queue.expire();

    const result = await eraseProjectRecords(deps, "acme", "  Asked by email on 2026-11-27  ");
    expect(result).toMatchObject({ queueItemsRemoved: 1, changed: true });
    expect(result.entriesErased).toBeGreaterThan(0);

    // Nothing of the project's is left in either store.
    expect(JSON.stringify([...escalations.items.values()])).not.toContain(SECRET_FIGURE);
    expect([...escalations.items.keys()]).toEqual([kept.id]);
    expect(audit.entries.filter((entry) => entry.project === "acme" && entry.kind !== "project_logs_deleted").every((entry) => entry.content === null)).toBe(true);
    expect(JSON.stringify(audit.entries)).not.toContain(SECRET_FIGURE);
    expect(audit.entries.find((entry) => entry.runId === "run-2" && entry.kind === "run_started")?.content).toContain("kept");

    const entry = audit.entries.at(-1);
    expect(entry).toMatchObject({ kind: "project_logs_deleted", project: "acme" });
    expect(JSON.parse(entry?.content ?? "{}")).toEqual({ by: ERASE_ACTOR, reason: "Asked by email on 2026-11-27", entriesErased: result.entriesErased, queueItemsRemoved: 1 });
    // The outline stays, so the chain still verifies.
    expect(await verifyChain(audit.entries, await audit.anchor())).toMatchObject({ ok: true });
  });

  it("refuses while an item of the project is still open, and changes nothing", async () => {
    const { deps, audit, log, escalations, queue } = setup();
    await log.record({ kind: "run_started", runId: "run-1", project: "acme", body: { script: "x" } });
    await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1" });
    const before = JSON.stringify(audit.entries);
    await expect(eraseProjectRecords(deps, "acme", "asked")).rejects.toThrow("1 item of this project is still waiting in the queue");
    expect(JSON.stringify(audit.entries)).toBe(before);
    expect(escalations.items.size).toBe(1);
  });

  it("needs a reason and a plain project name", async () => {
    const { deps, audit } = setup();
    await expect(eraseProjectRecords(deps, "acme", "   ")).rejects.toBeInstanceOf(EraseRefused);
    await expect(eraseProjectRecords(deps, "acme' OR 1=1 --", "asked")).rejects.toThrow("that is not a project name");
    await expect(eraseProjectRecords(deps, "", "asked")).rejects.toThrow("that is not a project name");
    expect(audit.entries).toEqual([]);
  });

  it("writes nothing for a name that has no records, a mistyped one for instance", async () => {
    const { deps, audit, log } = setup();
    await log.record({ kind: "run_started", runId: "run-1", project: "acme", body: { script: "x" } });
    expect(await eraseProjectRecords(deps, "acne", "asked")).toEqual({ entriesErased: 0, queueItemsRemoved: 0, changed: false });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.content).not.toBeNull();
  });
});
