/**
 * Deletes one project's records on request (FR-21; the client notice).
 *
 *   npm run project:erase -- --project NAME --yes --reason "who asked, and when"
 *
 * Removes the content of every audit log entry of the project and its closed
 * queue items, and writes one audit log entry saying so. It cannot be undone.
 * Needs a signed-in Wrangler, that is, control of the Cloudflare account.
 * Without `--yes` it changes nothing and says what it would do.
 * `--database NAME` aims it at another database, which is how it is tested.
 *
 * What stays is listed in src/audit/erase.ts.
 */
import { execFileSync } from "node:child_process";
import { EraseRefused, eraseProjectRecords } from "../src/audit/erase";
import { auditLog, d1AuditStore } from "../src/audit/log";
import { cliDatabase, type SqlRunner } from "../src/storage/cli-database";
import { d1EscalationStore } from "../src/storage/d1-stores";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const database = option("--database") ?? "execward";
const project = option("--project") ?? "";
const reason = option("--reason") ?? "";

if (!/^[a-z0-9-]+$/.test(database)) throw new Error("the database name is not valid");
if (project === "") {
  console.error('Name the project: npm run project:erase -- --project NAME --yes --reason "who asked, and when"');
  process.exit(2);
}
if (!args.includes("--yes")) {
  console.log(`This deletes the records of project "${project}" on the "${database}" database: the text of its audit log entries and its closed queue items.`);
  console.log("It cannot be undone. Copies stay in the daily backups for up to 7 days.");
  console.log(`To go ahead: npm run project:erase -- --project ${project} --yes --reason "who asked, and when"`);
  process.exit(2);
}

// Wrangler is run directly, with no shell in between, so the SQL reaches it exactly as written.
const run: SqlRunner = async (sql) => {
  const out = execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", database, "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const start = out.search(/[[{]/);
  if (start === -1) throw new Error("the database printed no JSON");
  const first = (JSON.parse(out.slice(start)) as { results?: unknown[]; success?: boolean; meta?: { changes?: number } }[])[0];
  if (!first || first.success === false) throw new Error("the database did not accept the statement");
  return { results: first.results ?? [], changes: first.meta?.changes ?? 0 };
};

const db = cliDatabase(run);
const audit = d1AuditStore(db);
try {
  const result = await eraseProjectRecords({ audit, log: auditLog(audit, Date.now), escalations: d1EscalationStore(db) }, project, reason);
  if (result.changed) {
    console.log(`DELETED. Project "${project}" on "${database}": the text of ${result.entriesErased} audit log entries and ${result.queueItemsRemoved} queue items.`);
    console.log("An audit log entry was written. The entries' outline stays for up to 90 days, and the daily backups hold the text for up to 7 days more.");
  } else {
    console.log(`Nothing to delete: "${database}" holds no log text and no queue items for project "${project}". Check the name. Nothing was changed.`);
  }
} catch (error) {
  if (!(error instanceof EraseRefused)) throw error;
  console.error(`Not deleted: ${error.message}.`);
  process.exit(1);
}
