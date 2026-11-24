/**
 * Adds the read-only GitHub tools and one project to a deployment's database
 * (task 2.1.10).
 *
 *   npm run setup:github -- --yes --project NAME --class internal
 *
 * Needs a signed-in Wrangler, that is, control of the Cloudflare account. It
 * writes an audit log entry and switches nothing on. `--database NAME` aims it
 * at another database.
 */
import { execFileSync } from "node:child_process";
import { auditLog, d1AuditStore } from "../src/audit/log";
import { putPolicyRecord } from "../src/broker/policy-store";
import { DATA_CLASSES, type DataClass } from "../src/contracts/policy";
import { setupGithub } from "../src/setup/github-setup";
import { cliDatabase, type SqlRunner } from "../src/storage/cli-database";
import { putProjectRecord } from "../src/storage/d1-stores";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const database = option("--database") ?? "execward";
const project = option("--project") ?? "";
const dataClass = option("--class") ?? "";

if (!/^[a-z0-9-]+$/.test(database)) throw new Error("the database name is not valid");
if (!(DATA_CLASSES as readonly string[]).includes(dataClass)) throw new Error(`--class must be one of: ${DATA_CLASSES.join(", ")}`);
if (!args.includes("--yes")) {
  console.log(`This adds the read-only GitHub tools and the project "${project}" (${dataClass}) to the "${database}" database.`);
  console.log("To go ahead: npm run setup:github -- --yes --project NAME --class CLASS");
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
const result = await setupGithub(
  { putPolicy: (record) => putPolicyRecord(db, record), putProject: (record) => putProjectRecord(db, record), audit: auditLog(d1AuditStore(db), Date.now) },
  { project, dataClass: dataClass as DataClass },
);
console.log(`Added ${result.tools.length} read-only GitHub tools and the project "${result.project.project}" (${result.project.dataClass}) on "${database}".`);
console.log("An audit log entry was written. Nothing was switched on.");
