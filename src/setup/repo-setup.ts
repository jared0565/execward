/**
 * Setting a repository up to use ExecWard, and checking that the setup works
 * (task 2.1.11; the project owner's request of 2026-11-26).
 *
 * The owner's rule: once ExecWard is added to a repository, getting it working
 * there is ExecWard's job, not a list of steps for a person. One command does
 * the work and says what it found:
 *
 *   - the tools it depends on are there (Node, the Claude Code command);
 *   - the folder is a git repository with a GitHub address;
 *   - production has a record of the project, since a project with no record
 *     is refused;
 *   - the MCP server is added to Claude Code for that folder, and connects;
 *   - the folder's CLAUDE.md names the project, in a block this command owns.
 *
 * It is safe to run again: every step looks first and changes only what is
 * missing or out of date. With `check` it changes nothing.
 *
 * This file is the part that decides. It touches nothing itself: reading
 * files, running commands and writing are handed in, so every path can be
 * tested. `scripts/repo-setup.ts` supplies the real ones.
 */

/** Raised when the block's wording or shape changes, so an older block is rewritten. */
export const BLOCK_VERSION = 1;

const BEGIN = /<!-- execward:begin v(\d+)[^>]*-->/;
const END = "<!-- execward:end -->";

/** The text this command keeps in a repository's CLAUDE.md. It names the project and nothing more. */
export function managedBlock(project: string): string {
  return [
    `<!-- execward:begin v${BLOCK_VERSION} (kept up to date by ExecWard's repo setup; change it there, not here) -->`,
    "## ExecWard",
    "",
    `When calling the execward \`code\` tool in this repository, pass the project name \`${project}\`.`,
    END,
  ].join("\n");
}

/**
 * Puts the block into a CLAUDE.md's text. An existing block is replaced where it stands;
 * otherwise the block goes at the end. Everything outside the block is left as it was.
 * Returns the same text when nothing needs to change.
 */
export function withManagedBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim() === "") return `${block}\n`;
  const begin = BEGIN.exec(existing);
  if (begin) {
    const end = existing.indexOf(END, begin.index);
    // A begin marker with no end: the rest is not ours to guess at, so the block is added afresh below it.
    if (end !== -1) return existing.slice(0, begin.index) + block + existing.slice(end + END.length);
  }
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  return `${existing.replace(/\s+$/, "")}${newline}${newline}${block.split("\n").join(newline)}${newline}`;
}

/** The owner and name in a GitHub address, in either of the forms git uses. */
export function githubRepoOf(remote: string): { readonly owner: string; readonly repo: string } | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match?.[1] !== undefined && match[2] !== undefined ? { owner: match[1], repo: match[2] } : undefined;
}

/** A project name made from a repository's name: lower case, and only what a project name may hold. */
export function projectNameFor(repo: string): string {
  return repo
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export type StepState =
  /** It was already right. */
  | "ok"
  /** It was wrong or missing, and this run put it right. */
  | "fixed"
  /** It is wrong or missing, and this run was asked to change nothing. */
  | "would_fix"
  /** It is wrong and this command cannot put it right. */
  | "failed"
  /** It could not be looked at from here. Not a pass. */
  | "not_checked";

export interface Step {
  readonly name: string;
  readonly state: StepState;
  readonly detail: string;
}

export interface RepoSetupDeps {
  /** Runs a command and returns what it printed, or `undefined` when it could not be run or failed. */
  readonly run: (command: string, args: readonly string[], cwd?: string) => Promise<string | undefined>;
  readonly readFile: (path: string) => Promise<string | undefined>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  /** Whether production has a record of the project. Throws when it cannot be read. */
  readonly projectOnRecord: (project: string) => Promise<boolean>;
  /** Adds the project's record to production. Left out, a missing record is reported and not added. */
  readonly addProject?: (project: string) => Promise<void>;
  readonly nodeVersion: string;
  /** Joins a folder and a file name the way the machine does. */
  readonly join: (folder: string, name: string) => string;
}

export interface RepoSetupOptions {
  readonly repo: string;
  /** Left out, it is made from the repository's name. */
  readonly project?: string;
  /** Look and report; change nothing. */
  readonly check: boolean;
  readonly serverName: string;
  readonly serverUrl: string;
  /** The model's name for the report header (task 2.1.6). Left out, no header is set. */
  readonly model?: string;
  readonly minNodeMajor: number;
}

export interface RepoSetupResult {
  readonly project: string | undefined;
  readonly steps: readonly Step[];
  /** True only when every step is `ok` or `fixed`. */
  readonly ready: boolean;
}

export async function setUpRepo(deps: RepoSetupDeps, options: RepoSetupOptions): Promise<RepoSetupResult> {
  const steps: Step[] = [];
  const add = (name: string, state: StepState, detail: string): void => void steps.push({ name, state, detail });
  const done = (project: string | undefined): RepoSetupResult => ({ project, steps, ready: steps.every((step) => step.state === "ok" || step.state === "fixed") });

  // 1. What this command and Claude Code depend on.
  const major = Number(/^v?(\d+)/.exec(deps.nodeVersion)?.[1]);
  if (Number.isFinite(major) && major >= options.minNodeMajor) add("Node", "ok", deps.nodeVersion);
  else add("Node", "failed", `${deps.nodeVersion} is older than version ${options.minNodeMajor}, which ExecWard's commands need. Install a newer Node`);
  const claude = (await deps.run("claude", ["--version"]))?.trim().split("\n")[0];
  if (claude === undefined || claude === "") {
    add("Claude Code", "failed", "the `claude` command was not found. Install Claude Code, then run this again");
    return done(undefined);
  }
  add("Claude Code", "ok", claude);

  // 2. The folder.
  const inside = (await deps.run("git", ["rev-parse", "--is-inside-work-tree"], options.repo))?.trim();
  if (inside !== "true") {
    add("Repository", "failed", `"${options.repo}" is not inside a git repository`);
    return done(undefined);
  }
  const remote = (await deps.run("git", ["remote", "get-url", "origin"], options.repo))?.trim();
  const github = remote === undefined ? undefined : githubRepoOf(remote);
  if (github === undefined) add("Repository", "failed", "its `origin` is not a GitHub address, and ExecWard's tools read GitHub only");
  else add("Repository", "ok", `${github.owner}/${github.repo}`);

  const project = options.project ?? (github === undefined ? undefined : projectNameFor(github.repo));
  if (project === undefined || !PROJECT_NAME.test(project)) {
    add("Project name", "failed", "give one with --project: lower-case letters, digits, dots, dashes or underscores");
    return done(undefined);
  }

  // 3. The project's record. A call that names a project with no record is refused.
  try {
    if (await deps.projectOnRecord(project)) add("Project record", "ok", `production has "${project}"`);
    else if (options.check) add("Project record", "would_fix", `production has no project "${project}"`);
    else if (deps.addProject === undefined) add("Project record", "failed", `production has no project "${project}". Run this again with --add-project to add it`);
    else {
      await deps.addProject(project);
      add("Project record", (await deps.projectOnRecord(project)) ? "fixed" : "failed", `added "${project}" to production, and read it back`);
    }
  } catch {
    add("Project record", "failed", "production's list of projects could not be read. Is Wrangler signed in?");
  }

  // 4. The MCP server, in Claude Code's settings for that folder.
  const wanted = options.serverUrl;
  const read = async (): Promise<string | undefined> => deps.run("claude", ["mcp", "get", options.serverName], options.repo);
  let server = await read();
  const pointsAt = (text: string | undefined): boolean => text !== undefined && text.includes(wanted);
  if (pointsAt(server)) add("MCP server", "ok", `"${options.serverName}" is set to ${wanted}`);
  else if (options.check) add("MCP server", "would_fix", server === undefined ? `"${options.serverName}" is not added for this folder` : `"${options.serverName}" points somewhere else`);
  else {
    // One that points elsewhere is replaced: the name must mean this server.
    if (server !== undefined) await deps.run("claude", ["mcp", "remove", options.serverName, "-s", "local"], options.repo);
    await deps.run("claude", ["mcp", "add", "--transport", "http", "--scope", "local", options.serverName, wanted, ...(options.model === undefined ? [] : ["--header", `X-ExecWard-Model: ${options.model}`])], options.repo);
    server = await read();
    if (pointsAt(server)) add("MCP server", "fixed", `added "${options.serverName}" for this folder, private to this computer`);
    else add("MCP server", "failed", "Claude Code did not keep the server. Try `claude mcp add` by hand in that folder");
  }

  // 5. Whether it answers. Claude Code reports this itself.
  if (!pointsAt(server)) add("Connection", "not_checked", "there is no server to connect to yet");
  else if (/Status:.*Connected/.test(server ?? "")) add("Connection", "ok", "Claude Code reports it connected");
  else if (/Needs authentication/i.test(server ?? "")) add("Connection", "failed", "it needs you to sign in once: open Claude Code in that folder, type /mcp, choose the server and sign in");
  else add("Connection", "failed", "Claude Code does not report it connected. In that folder, run `claude mcp get " + options.serverName + "`");

  // 6. The line that tells a model in that folder which project to name.
  const path = deps.join(options.repo, "CLAUDE.md");
  const existing = await deps.readFile(path);
  const next = withManagedBlock(existing, managedBlock(project));
  if (existing === next) add("CLAUDE.md", "ok", `names the project "${project}"`);
  else if (options.check) add("CLAUDE.md", "would_fix", existing === undefined ? "there is none" : "it does not name the project, or its ExecWard block is out of date");
  else {
    await deps.writeFile(path, next);
    add("CLAUDE.md", "fixed", existing === undefined ? "written" : "ExecWard's block added or brought up to date; nothing else in the file was changed");
  }

  // 7. Said plainly, so that a clean report is not read as more than it is.
  add(
    "GitHub App access",
    "not_checked",
    github === undefined
      ? "there is no GitHub repository to check"
      : `this command cannot see what the GitHub App may read. To check, ask ExecWard itself: a script that calls github_get_repository for ${github.owner}/${github.repo}`,
  );

  // The last step is information, not a failure of the setup.
  const counted = steps.filter((step) => step.name !== "GitHub App access");
  return { project, steps, ready: counted.every((step) => step.state === "ok" || step.state === "fixed") };
}

const MARK: Record<StepState, string> = { ok: "ok       ", fixed: "fixed    ", would_fix: "TO FIX   ", failed: "FAILED   ", not_checked: "unchecked" };

/** The report, one line a step. */
export function reportLines(result: RepoSetupResult): string[] {
  return [
    ...result.steps.map((step) => `  ${MARK[step.state]}  ${step.name}: ${step.detail}`),
    "",
    result.ready ? `Ready. Project name: ${result.project}.` : "Not ready: see the lines marked FAILED or TO FIX.",
  ];
}
