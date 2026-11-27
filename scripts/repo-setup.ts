/**
 * Sets a repository up to use ExecWard, and checks that the setup works
 * (task 2.1.11).
 *
 *   npm run repo:setup -- --repo PATH                 set it up, or put right what has drifted
 *   npm run repo:setup -- --repo PATH --check         look and report; change nothing
 *
 * --project NAME    Left out, the name is made from the repository's name.
 * --add-project     Add the project's record to production if it has none. Needs a
 *                   signed-in Wrangler, and writes one audit log entry.
 * --class CLASS     The data class for a project being added. Default: internal.
 * --model NAME      Sent as the X-ExecWard-Model header, for grouping reports.
 *
 * It writes two things outside this repository, and only these: Claude Code's
 * own settings for that folder (through `claude mcp add`, private to this
 * computer), and one marked block in that folder's CLAUDE.md.
 *
 * Exit code: 0 when everything is ready, 1 when something is not.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { auditLog, d1AuditStore } from "../src/audit/log";
import { DATA_CLASSES, type DataClass } from "../src/contracts/policy";
import { addProject } from "../src/setup/github-setup";
import { reportLines, setUpRepo } from "../src/setup/repo-setup";
import { cliDatabase, type SqlRunner } from "../src/storage/cli-database";
import { putProjectRecord } from "../src/storage/d1-stores";

const SERVER_NAME = "execward";
const SERVER_URL = "https://mcp.execward.com/mcp";
const DATABASE = "execward";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const repo = option("--repo");
if (repo === undefined) {
  console.error("Give the repository's folder: npm run repo:setup -- --repo PATH [--check]");
  process.exit(2);
}
const dataClass = option("--class") ?? "internal";
if (!(DATA_CLASSES as readonly string[]).includes(dataClass)) {
  console.error(`--class must be one of: ${DATA_CLASSES.join(", ")}`);
  process.exit(2);
}

const RUN_OPTIONS = { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true } as const;

/**
 * Runs a command with no shell in between. Where Windows has `claude` only as a script
 * (an npm install), a program cannot be started directly, so that one command is tried
 * again through the shell, with every argument checked to hold nothing a shell would act on.
 */
function run(command: string, commandArgs: readonly string[], cwd?: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(command, [...commandArgs], { ...RUN_OPTIONS, cwd }, (error, stdout) => {
      if (!error) return done(stdout);
      const notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      const plain = commandArgs.every((arg) => /^[A-Za-z0-9 _.:/=@-]*$/.test(arg));
      if (!(notFound && process.platform === "win32" && command === "claude" && plain)) return done(undefined);
      const line = ["claude", ...commandArgs.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))].join(" ");
      execFile(line, { ...RUN_OPTIONS, cwd, shell: true }, (again, out) => done(again ? undefined : out));
    });
  });
}

const wrangler: SqlRunner = async (sql) => {
  const out = await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", DATABASE, "--remote", "--json", "--command", sql]);
  if (out === undefined) throw new Error("the database could not be reached");
  const start = out.search(/[[{]/);
  if (start === -1) throw new Error("the database printed no JSON");
  const first = (JSON.parse(out.slice(start)) as { results?: unknown[]; success?: boolean; meta?: { changes?: number } }[])[0];
  if (!first || first.success === false) throw new Error("the database did not accept the statement");
  return { results: first.results ?? [], changes: first.meta?.changes ?? 0 };
};
const db = cliDatabase(wrangler);

const result = await setUpRepo(
  {
    run,
    readFile: (path) => readFile(path, "utf8").catch(() => undefined),
    writeFile: (path, text) => writeFile(path, text, "utf8"),
    // The name was checked against the project-name pattern before it gets here, so it holds no quote.
    projectOnRecord: async (project) => (await wrangler(`SELECT project FROM projects WHERE project = '${project}'`)).results.length > 0,
    ...(args.includes("--add-project")
      ? {
          addProject: async (project: string) => {
            // The project's record only. The tools' policy records are `setup:github`'s to write.
            await addProject({ putProject: (record) => putProjectRecord(db, record), audit: auditLog(d1AuditStore(db), Date.now) }, { project, dataClass: dataClass as DataClass });
          },
        }
      : {}),
    nodeVersion: process.version,
    join,
  },
  {
    repo: resolve(repo),
    ...(option("--project") === undefined ? {} : { project: option("--project") as string }),
    check: args.includes("--check"),
    serverName: SERVER_NAME,
    serverUrl: SERVER_URL,
    ...(option("--model") === undefined ? {} : { model: option("--model") as string }),
    minNodeMajor: 22,
  },
);

console.log(`ExecWard setup for ${resolve(repo)}${args.includes("--check") ? " (checking only)" : ""}`);
for (const line of reportLines(result)) console.log(line);
process.exitCode = result.ready ? 0 : 1;
