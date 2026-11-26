import { describe, expect, it } from "vitest";
import { BLOCK_VERSION, githubRepoOf, managedBlock, projectNameFor, reportLines, setUpRepo, withManagedBlock, type RepoSetupDeps, type RepoSetupOptions } from "../src/setup/repo-setup";

const URL_ = "https://mcp.execward.com/mcp";
const OPTIONS: RepoSetupOptions = { repo: "/work/site", check: false, serverName: "execward", serverUrl: URL_, minNodeMajor: 22 };
const CONNECTED = `execward:\n  Scope: Local config\n  Status: ✔ Connected\n  Type: http\n  URL: ${URL_}\n`;

/** A made-up computer: what is installed, what is on record, and what the commands answer. */
function machine(start: { claude?: boolean; git?: boolean; remote?: string; server?: string; projects?: string[]; files?: Record<string, string>; node?: string; keepsServer?: boolean; canAdd?: boolean } = {}) {
  const files = new Map(Object.entries(start.files ?? {}));
  const projects = new Set(start.projects ?? []);
  const ran: string[] = [];
  const written: string[] = [];
  let server = start.server;
  const deps: RepoSetupDeps = {
    nodeVersion: start.node ?? "v24.16.0",
    join: (folder, name) => `${folder}/${name}`,
    readFile: async (path) => files.get(path),
    writeFile: async (path, text) => {
      written.push(path);
      files.set(path, text);
    },
    projectOnRecord: async (project) => projects.has(project),
    ...(start.canAdd === false ? {} : { addProject: async (project: string) => void projects.add(project) }),
    run: async (command, args) => {
      const line = [command, ...args].join(" ");
      ran.push(line);
      if (line === "claude --version") return start.claude === false ? undefined : "2.1.332 (Claude Code)\n";
      if (line === "git rev-parse --is-inside-work-tree") return start.git === false ? undefined : "true\n";
      if (line === "git remote get-url origin") return start.remote ?? "https://github.com/someone/My-Site.git\n";
      if (line === "claude mcp get execward") return server;
      if (line.startsWith("claude mcp remove execward")) {
        server = undefined;
        return "";
      }
      if (line.startsWith("claude mcp add ")) {
        if (start.keepsServer !== false) server = CONNECTED;
        return "";
      }
      return undefined;
    },
  };
  return { deps, files, projects, ran, written };
}

const states = (steps: readonly { name: string; state: string }[]) => Object.fromEntries(steps.map((step) => [step.name, step.state]));

describe("the block kept in a repository's CLAUDE.md", () => {
  const block = managedBlock("my-site");

  it("names the project and says who keeps it", () => {
    expect(block).toContain("pass the project name `my-site`");
    expect(block).toContain(`execward:begin v${BLOCK_VERSION}`);
    expect(block.endsWith("<!-- execward:end -->")).toBe(true);
  });

  it("is the whole file when there is no file, or an empty one", () => {
    expect(withManagedBlock(undefined, block)).toBe(`${block}\n`);
    expect(withManagedBlock("  \n", block)).toBe(`${block}\n`);
  });

  it("goes at the end of a file that has none, leaving the rest alone", () => {
    const next = withManagedBlock("# Rules\n\nBe kind.\n", block);
    expect(next.startsWith("# Rules\n\nBe kind.\n\n")).toBe(true);
    expect(next.endsWith(`${block}\n`)).toBe(true);
  });

  it("replaces an older block where it stands, and nothing else", () => {
    const old = "# Rules\n\n<!-- execward:begin v0 (old) -->\nold words\n<!-- execward:end -->\n\n## After\n";
    const next = withManagedBlock(old, block);
    expect(next).toBe(`# Rules\n\n${block}\n\n## After\n`);
    expect(next).not.toContain("old words");
  });

  it("changes nothing when run a second time", () => {
    const once = withManagedBlock("# Rules\n", block);
    expect(withManagedBlock(once, block)).toBe(once);
  });

  it("keeps a file's Windows line endings", () => {
    const next = withManagedBlock("# Rules\r\n\r\nBe kind.\r\n", block);
    expect(next.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("reading a repository's address", () => {
  it.each([
    ["https://github.com/someone/My-Site.git", "someone", "My-Site"],
    ["https://github.com/someone/My-Site", "someone", "My-Site"],
    ["git@github.com:someone/my.site.git", "someone", "my.site"],
    ["ssh://git@github.com/someone/site.git", "someone", "site"],
  ])("reads %s", (remote, owner, repo) => {
    expect(githubRepoOf(remote)).toEqual({ owner, repo });
  });

  it.each(["https://gitlab.com/someone/site.git", "https://github.com.evil.example/a/b.git", "not an address", "https://github.com/only-owner"])("does not take %s for a GitHub repository", (remote) => {
    expect(githubRepoOf(remote)).toBeUndefined();
  });

  it("makes a project name a project may have", () => {
    expect(projectNameFor("Bytes-Web")).toBe("bytes-web");
    expect(projectNameFor("My Site!")).toBe("my-site-");
    expect(projectNameFor("_private")).toBe("private");
  });
});

describe("setting a repository up", () => {
  it("does everything for a repository that has nothing yet, and says what it did", async () => {
    const { deps, files, projects, ran } = machine();
    const result = await setUpRepo(deps, { ...OPTIONS, model: "claude-fable-5-2" });
    expect(result.project).toBe("my-site");
    expect(states(result.steps)).toEqual({
      Node: "ok",
      "Claude Code": "ok",
      Repository: "ok",
      "Project record": "fixed",
      "MCP server": "fixed",
      Connection: "ok",
      "CLAUDE.md": "fixed",
      "GitHub App access": "not_checked",
    });
    expect(result.ready).toBe(true);
    expect(projects.has("my-site")).toBe(true);
    expect(files.get("/work/site/CLAUDE.md")).toContain("pass the project name `my-site`");
    expect(ran).toContain(`claude mcp add --transport http --scope local execward ${URL_} --header X-ExecWard-Model: claude-fable-5-2`);
    expect(reportLines(result).at(-1)).toBe("Ready. Project name: my-site.");
  });

  it("changes nothing the second time", async () => {
    const { deps, written, ran } = machine();
    await setUpRepo(deps, OPTIONS);
    const before = { written: written.length, ran: ran.length };
    const again = await setUpRepo(deps, OPTIONS);
    expect(Object.values(states(again.steps)).filter((state) => state === "fixed")).toEqual([]);
    expect(again.ready).toBe(true);
    expect(written).toHaveLength(before.written);
    expect(ran.slice(before.ran).some((line) => line.startsWith("claude mcp add") || line.startsWith("claude mcp remove"))).toBe(false);
  });

  it("only looks when asked to check, and is then not ready", async () => {
    const { deps, written, projects, ran } = machine();
    const result = await setUpRepo(deps, { ...OPTIONS, check: true });
    expect(states(result.steps)).toMatchObject({ "Project record": "would_fix", "MCP server": "would_fix", Connection: "not_checked", "CLAUDE.md": "would_fix" });
    expect(result.ready).toBe(false);
    expect(written).toEqual([]);
    expect(projects.size).toBe(0);
    expect(ran.some((line) => line.startsWith("claude mcp add"))).toBe(false);
    expect(reportLines(result).at(-1)).toContain("Not ready");
  });

  it("does not add a project to production unless it was told it may", async () => {
    const { deps, projects } = machine({ canAdd: false });
    const result = await setUpRepo(deps, OPTIONS);
    expect(states(result.steps)["Project record"]).toBe("failed");
    expect(result.steps.find((step) => step.name === "Project record")?.detail).toContain("--add-project");
    expect(projects.size).toBe(0);
    expect(result.ready).toBe(false);
  });

  it("uses the project name it is given", async () => {
    const { deps, files } = machine({ projects: ["shop"] });
    const result = await setUpRepo(deps, { ...OPTIONS, project: "shop" });
    expect(states(result.steps)["Project record"]).toBe("ok");
    expect(files.get("/work/site/CLAUDE.md")).toContain("`shop`");
  });

  it("replaces a server of the same name that points somewhere else", async () => {
    const { deps, ran } = machine({ projects: ["my-site"], server: "execward:\n  Status: ✔ Connected\n  URL: https://elsewhere.example/mcp\n" });
    const result = await setUpRepo(deps, OPTIONS);
    expect(states(result.steps)["MCP server"]).toBe("fixed");
    expect(ran.findIndex((line) => line.startsWith("claude mcp remove execward"))).toBeLessThan(ran.findIndex((line) => line.startsWith("claude mcp add")));
  });

  it("says so when the server needs a sign-in, which only a person can do", async () => {
    const { deps } = machine({ projects: ["my-site"], server: `execward:\n  Status: ! Needs authentication\n  URL: ${URL_}\n` });
    const result = await setUpRepo(deps, OPTIONS);
    expect(states(result.steps)).toMatchObject({ "MCP server": "ok", Connection: "failed" });
    expect(result.steps.find((step) => step.name === "Connection")?.detail).toContain("/mcp");
    expect(result.ready).toBe(false);
  });

  it("reports a server Claude Code did not keep", async () => {
    const { deps } = machine({ projects: ["my-site"], keepsServer: false });
    const result = await setUpRepo(deps, OPTIONS);
    expect(states(result.steps)).toMatchObject({ "MCP server": "failed", Connection: "not_checked" });
    expect(result.ready).toBe(false);
  });

  it.each([
    ["Claude Code is not installed", { claude: false }, "Claude Code"],
    ["the folder is not a git repository", { git: false }, "Repository"],
  ])("stops, changing nothing, when %s", async (_label, start, failing) => {
    const { deps, written, projects } = machine(start);
    const result = await setUpRepo(deps, OPTIONS);
    expect(result.steps.at(-1)).toMatchObject({ name: failing, state: "failed" });
    expect(result.ready).toBe(false);
    expect(written).toEqual([]);
    expect(projects.size).toBe(0);
  });

  it("fails on a Node too old for ExecWard's commands", async () => {
    const { deps } = machine({ node: "v18.20.0" });
    const result = await setUpRepo(deps, OPTIONS);
    expect(states(result.steps).Node).toBe("failed");
    expect(result.ready).toBe(false);
  });

  it("needs a project name when the repository is not on GitHub", async () => {
    const { deps } = machine({ remote: "https://gitlab.com/someone/site.git" });
    const result = await setUpRepo(deps, OPTIONS);
    expect(states(result.steps)).toMatchObject({ Repository: "failed", "Project name": "failed" });
  });

  it("refuses a project name production would refuse", async () => {
    const { deps, written } = machine();
    const result = await setUpRepo(deps, { ...OPTIONS, project: "Not A Name'; DROP" });
    expect(states(result.steps)["Project name"]).toBe("failed");
    expect(written).toEqual([]);
  });

  it("reports a list of projects it could not read as a failure, not as a missing project", async () => {
    const { deps, projects } = machine();
    const result = await setUpRepo({ ...deps, projectOnRecord: async () => Promise.reject(new Error("not signed in")) }, OPTIONS);
    expect(result.steps.find((step) => step.name === "Project record")).toMatchObject({ state: "failed" });
    expect(projects.size).toBe(0);
  });

  it("never reports the GitHub App's access as checked", async () => {
    const { deps } = machine();
    const result = await setUpRepo(deps, OPTIONS);
    expect(result.steps.at(-1)).toMatchObject({ name: "GitHub App access", state: "not_checked" });
    expect(reportLines(result).join("\n")).toContain("unchecked  GitHub App access");
  });
});
