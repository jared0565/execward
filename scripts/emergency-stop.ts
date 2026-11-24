/**
 * Sets the kill switch straight in the database (incident runbook step 1).
 * For when the owner cannot sign in to the console.
 *
 *   npm run emergency:stop -- --yes --reason "why"
 *
 * Needs a signed-in Wrangler, that is, control of the Cloudflare account. It
 * can only stop: clearing the kill switch still needs the console. It writes
 * an audit log entry. `--database NAME` aims it at another database, which is
 * how it is tested.
 */
import { execFileSync } from "node:child_process";
import { auditLog, d1AuditStore } from "../src/audit/log";
import { emergencyStop } from "../src/console/emergency";
import { cliDatabase, type SqlRunner } from "../src/storage/cli-database";
import { d1ControlStore } from "../src/storage/d1-stores";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const database = option("--database") ?? "execward";
const reason = option("--reason") ?? "";

if (!/^[a-z0-9-]+$/.test(database)) throw new Error("the database name is not valid");
if (!args.includes("--yes")) {
  console.log(`This sets the kill switch on the "${database}" database. Nothing will run until it is cleared from the console.`);
  console.log('To go ahead: npm run emergency:stop -- --yes --reason "why"');
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
const result = await emergencyStop({ control: d1ControlStore(db), audit: auditLog(d1AuditStore(db), Date.now) }, reason);
if (result.changed) {
  console.log(`STOPPED. The kill switch is set on "${database}" (version ${result.after.version}). Nothing runs until it is cleared from the console.`);
  console.log("An audit log entry was written. Carry on with the incident runbook, step 2.");
} else {
  console.log(`The kill switch was already set on "${database}" (version ${result.after.version}). Nothing was changed.`);
}
