/**
 * Copies the production audit log to this computer and checks it (incident
 * runbook step 3).
 *
 *   npm run audit:export                 copy the log and check it
 *   npm run audit:export -- --check FILE check a copy made earlier
 *
 * Needs a signed-in Wrangler. Reads only. The copy is written outside this
 * repository, in `.execward/audit-exports` in your home folder, because the
 * log can hold client data and the repository is public. Exits 1 if the chain
 * does not verify: that is itself a finding.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { auditExport, recheck, type AuditExport, type AuditRow } from "../src/audit/export";
import type { ChainAnchor, ChainCheck } from "../src/audit/log";

function query<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "execward", "--remote", "--json", "--command", `"${sql}"`], {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 512 * 1024 * 1024,
  });
  const start = out.search(/[[{]/);
  if (start === -1) throw new Error("the database query printed no JSON");
  const parsed = JSON.parse(out.slice(start)) as { results?: T[]; success?: boolean }[];
  const first = parsed[0];
  if (!first || first.success === false || !Array.isArray(first.results)) throw new Error("the database query did not succeed");
  return first.results;
}

function report(check: ChainCheck): boolean {
  if (check.ok) {
    console.log(`The chain verifies: ${check.entries} entries, each present, in order and unchanged.`);
    return true;
  }
  console.error(`THE CHAIN DOES NOT VERIFY at entry ${check.seq}: ${check.reason}. Treat this as a finding (incident runbook, step 3).`);
  return false;
}

const args = process.argv.slice(2);
const checkAt = args.indexOf("--check");

if (checkAt !== -1) {
  const file = args[checkAt + 1];
  if (!file) throw new Error("--check needs a file");
  const saved = JSON.parse(readFileSync(file, "utf8")) as AuditExport;
  console.log(`Checking the copy made ${saved.exportedAt} from ${saved.source}.`);
  process.exitCode = report(await recheck(saved)) ? 0 : 1;
} else {
  const rows = query<AuditRow>("SELECT seq, at, kind, run_id, project, security, content, content_hash, prev_hash, hash FROM audit_log ORDER BY seq");
  const anchors = query<ChainAnchor>("SELECT seq, hash FROM audit_anchor WHERE id = 1");
  const exported = await auditExport(rows, anchors[0], "production");
  const dir = join(homedir(), ".execward", "audit-exports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `audit-${exported.exportedAt.replaceAll(":", "-")}.json`);
  writeFileSync(file, JSON.stringify(exported, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(`Copied ${exported.entries.length} entries, from ${exported.first ?? "-"} to ${exported.last ?? "-"}.`);
  console.log(`By kind: ${Object.entries(exported.kinds).map(([kind, count]) => `${kind} ${count}`).join(", ") || "none"}.`);
  console.log(`Written to ${file}`);
  console.log("Keep a copy somewhere other than this computer and Cloudflare.");
  process.exitCode = report(exported.check) ? 0 : 1;
}
