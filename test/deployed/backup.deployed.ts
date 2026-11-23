/**
 * Backup to a real R2 bucket and restore into an emptied D1 database, on the
 * deployed test Worker (task 1.4.5). Run with `npm run test:deployed`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

const URL_BASE = setting("EXECWARD_TEST_URL", "test-worker-url");
const SECRET = setting("EXECWARD_TEST_SECRET", "test-worker-secret");

interface BackupReply {
  readonly taken: { key: string; rows: Record<string, number>; bytes: number; sha256: string; pruned: number };
  readonly keys: string[];
  readonly restored: { rows: Record<string, number> } | { error: string };
  readonly sameAuditLog: boolean;
  readonly chain: { ok: boolean };
  readonly control: unknown;
  readonly policyPaths: string[];
  readonly escalations: number;
}

async function backup(body: Record<string, unknown> = {}): Promise<BackupReply> {
  const response = await fetch(`${URL_BASE}/backup`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`the test Worker answered ${response.status}`);
  return (await response.json()) as BackupReply;
}

describe("backup and restore on Cloudflare (task 1.4.5)", { timeout: 120_000 }, () => {
  it("writes a backup outside the database, and restores it into an emptied database with the audit chain intact", async () => {
    const reply = await backup({ auditEvents: 40 });
    expect(reply.taken.key).toMatch(/^backups\/\d{4}-\d{2}-\d{2}\.json$/);
    expect(reply.taken.rows).toMatchObject({ policy: 3, audit_log: 40, escalations: 1, control_state: 1, projects: 1 });
    expect(reply.keys).toContain(reply.taken.key);
    expect(reply.restored).toEqual({ rows: reply.taken.rows });
    expect(reply.sameAuditLog).toBe(true);
    expect(reply.chain).toMatchObject({ ok: true });
    expect(reply.control).toMatchObject({ codeMode: true, pausedProjects: ["paused-one"] });
    expect(reply.policyPaths.length).toBe(3);
  });

  it("refuses to restore a backup that was changed after it was written", async () => {
    const reply = await backup({ tamperBackup: true });
    expect(reply.restored).toEqual({ error: "BackupError: the backup does not match its recorded hash" });
    expect(reply.escalations).toBe(0);
  });

  it("deletes backups older than seven days and keeps the rest", async () => {
    const now = Date.UTC(2027, 0, 15, 12);
    const reply = await backup({ now, olderObjects: ["backups/2027-01-01.json", "backups/2027-01-09.json"] });
    expect(reply.taken.pruned).toBe(1);
    expect(reply.keys).toEqual(["backups/2027-01-09.json", "backups/2027-01-15.json"]);
  });
});
