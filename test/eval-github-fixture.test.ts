import { expect, test } from "vitest";
import { githubFixtureBackend } from "../src/eval/fixtures/github-backend";
import { buildWorld, WORLD_NOW, WORLD_OWNER } from "../src/eval/fixtures/world";
import { GITHUB_READ_ONLY_TOOLS } from "../src/tools/github-inventory";

const world = buildWorld();
const backend = githubFixtureBackend(world);
const owner = WORLD_OWNER;
const repo = "billing-api";
const billing = world.repos.find((candidate) => candidate.name === repo);
if (billing === undefined) throw new Error("fixture repo missing");

type Row = Record<string, unknown>;
const call = (name: string, args: unknown) => backend.call(name, args) as Promise<unknown>;
const rows = async (name: string, args: unknown) => (await call(name, args)) as Row[];

test("the backend offers exactly the tools of the inventory, in the same order", () => {
  expect(backend.definitions.map((tool) => tool.name)).toEqual(
    GITHUB_READ_ONLY_TOOLS.map((tool) => tool.tool),
  );
  for (const tool of backend.definitions) {
    expect(tool.inputSchema).toMatchObject({ type: "object" });
    expect(tool.inputSchema).not.toHaveProperty("$schema");
    expect(tool.description.length).toBeGreaterThan(20);
  }
});

test("the world is the same every time it is built, and nothing is dated after its clock", () => {
  expect(buildWorld()).toEqual(world);
  const dates = JSON.stringify(world).match(/\d{4}-\d{2}-\d{2}T[\d:]+Z/g) ?? [];
  expect(dates.length).toBeGreaterThan(500);
  for (const date of dates) expect(Date.parse(date)).toBeLessThanOrEqual(WORLD_NOW);
});

test("the world has enough variety for tasks to tell answers apart", () => {
  for (const candidate of world.repos) {
    const issues = candidate.issues.filter((issue) => issue.pull === null);
    const pulls = candidate.issues.filter((issue) => issue.pull !== null);
    expect(issues.some((issue) => issue.state === "open")).toBe(true);
    expect(issues.some((issue) => issue.state === "closed")).toBe(true);
    expect(pulls.some((issue) => issue.pull?.merged)).toBe(true);
    expect(candidate.runs.some((run) => run.conclusion === "failure")).toBe(true);
  }
});

test("every tool answers a plain request with data that survives JSON", async () => {
  const pull = billing.issues.find((issue) => issue.pull !== null);
  const samples: Record<string, unknown> = {
    get_repository: { owner, repo },
    list_branches: { owner, repo },
    list_commits: { owner, repo },
    get_commit: { owner, repo, ref: "main" },
    get_file_contents: { owner, repo, path: "README.md" },
    search_code: { q: "MAX_RETRIES" },
    list_issues: { owner, repo },
    get_issue: { owner, repo, issue_number: 1 },
    list_issue_comments: { owner, repo, issue_number: 1 },
    search_issues: { q: `repo:${owner}/${repo} is:open` },
    list_pull_requests: { owner, repo, state: "all" },
    get_pull_request: { owner, repo, pull_number: pull?.number },
    list_pull_request_files: { owner, repo, pull_number: pull?.number },
    list_releases: { owner, repo },
    list_workflow_runs: { owner, repo },
  };
  expect(Object.keys(samples)).toEqual(backend.definitions.map((tool) => tool.name));
  for (const [name, args] of Object.entries(samples)) {
    const result = await call(name, args);
    expect(JSON.parse(JSON.stringify(result)), name).toEqual(result);
  }
});

test("list_issues returns pull requests too, marked as GitHub marks them", async () => {
  const listed = await rows("list_issues", { owner, repo, state: "all", per_page: 100 });
  expect(listed).toHaveLength(billing.issues.length);
  const marked = listed.filter((entry) => "pull_request" in entry).map((entry) => entry["number"]);
  const pulls = billing.issues.filter((issue) => issue.pull !== null).map((issue) => issue.number);
  expect(marked.sort()).toEqual(pulls.sort());

  const open = await rows("list_issues", { owner, repo, per_page: 100 });
  expect(open).toHaveLength(billing.issues.filter((issue) => issue.state === "open").length);
  expect((open[0]?.["created_at"] as string) > (open[1]?.["created_at"] as string)).toBe(true);
});

test("filters and paging narrow a list the way the request says", async () => {
  const bugs = await rows("list_issues", { owner, repo, state: "all", labels: "bug", per_page: 100 });
  expect(bugs).toHaveLength(billing.issues.filter((issue) => issue.labels.includes("bug")).length);
  expect(bugs.length).toBeGreaterThan(0);

  const first = await rows("list_commits", { owner, repo, per_page: 5 });
  const second = await rows("list_commits", { owner, repo, per_page: 5, page: 2 });
  expect(first.map((commit) => commit["sha"])).toEqual(billing.commits.slice(0, 5).map((c) => c.sha));
  expect(second.map((commit) => commit["sha"])).toEqual(billing.commits.slice(5, 10).map((c) => c.sha));

  const failed = (await call("list_workflow_runs", { owner, repo, status: "failure" })) as Row;
  expect(failed["total_count"]).toBe(billing.runs.filter((run) => run.conclusion === "failure").length);
});

test("search matches words and qualifiers, and refuses a qualifier it does not know", async () => {
  const merged = (await call("search_issues", { q: `repo:${owner}/${repo} is:pr is:merged`, per_page: 100 })) as Row;
  expect(merged["total_count"]).toBe(billing.issues.filter((issue) => issue.pull?.merged).length);

  const code = (await call("search_code", { q: `MAX_RETRIES org:${owner}` })) as { items: Row[] };
  expect(code.items.map((item) => item["path"]).sort()).toEqual(["backup.py", "src/api-client.ts", "src/webhook.ts"]);

  await expect(call("search_issues", { q: "milestone:v2 crash" })).rejects.toThrow(/422.*milestone/);
});

test("files come back as text, and a directory as a listing", async () => {
  const file = (await call("get_file_contents", { owner, repo, path: "src/webhook.ts" })) as Row;
  expect(file).toMatchObject({ type: "file", encoding: "utf-8", path: "src/webhook.ts" });
  expect(file["content"]).toContain("MAX_RETRIES = 5");

  const root = await rows("get_file_contents", { owner, repo, path: "" });
  expect(root.map((entry) => [entry["path"], entry["type"]])).toEqual([
    ["README.md", "file"],
    ["package.json", "file"],
    ["src", "dir"],
    [".github", "dir"],
  ]);
});

test("a missing thing, a wrong argument and an unknown tool are errors, as on GitHub", async () => {
  await expect(call("get_issue", { owner, repo, issue_number: 9999 })).rejects.toThrow("404 Not Found");
  await expect(call("get_repository", { owner, repo: "nope" })).rejects.toThrow("404 Not Found");
  await expect(call("get_issue", { owner, repo, issue_number: "1" })).rejects.toThrow(/^422 Validation Failed/);
  await expect(call("delete_repository", { owner, repo })).rejects.toThrow("404");
  const issue = billing.issues.find((candidate) => candidate.pull === null);
  await expect(call("get_pull_request", { owner, repo, pull_number: issue?.number })).rejects.toThrow("404");
});
