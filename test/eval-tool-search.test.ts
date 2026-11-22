import { expect, test } from "vitest";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, toolSearchBackend } from "../src/eval/arms/tool-search";
import { githubFixtureBackend } from "../src/eval/fixtures/github-backend";
import { WORLD_OWNER } from "../src/eval/fixtures/world";
import { runTask } from "../src/eval/harness";
import type { EvalTask, ModelProvider, ModelTurn, TurnRequest } from "../src/eval/types";

const github = githubFixtureBackend();
const names = (backend: { definitions: readonly { name: string }[] }) =>
  backend.definitions.map((tool) => tool.name);
type Found = { tools: { name: string; input_schema?: unknown }[] };
const billing = { owner: WORLD_OWNER, repo: "billing-api" };

test("the offered tools are the search tool and the call tool, before and after a search", async () => {
  const backend = toolSearchBackend(github);
  const before = backend.definitions;
  expect(names(backend)).toEqual([SEARCH_TOOL_NAME, CALL_TOOL_NAME]);

  await backend.call(SEARCH_TOOL_NAME, { query: "list issues" });

  // The very same list: Claude rejects a conversation whose tool list changes.
  expect(backend.definitions).toBe(before);
});

test("a search returns the best matches with their schemas, and they can then be called", async () => {
  const backend = toolSearchBackend(github);

  const result = (await backend.call(SEARCH_TOOL_NAME, { query: "list issues" })) as Found;

  expect(result.tools[0]?.name).toBe("list_issues");
  expect(result.tools[0]?.input_schema).toMatchObject({ type: "object" });
  expect(result.tools.length).toBeLessThanOrEqual(5);
  const issues = await backend.call(CALL_TOOL_NAME, { name: "list_issues", arguments: billing });
  expect(issues).toEqual(await github.call("list_issues", billing));
});

test("a tool that has not been found cannot be called, by either door", async () => {
  const backend = toolSearchBackend(github);
  await expect(backend.call(CALL_TOOL_NAME, { name: "list_issues", arguments: billing })).rejects.toThrow(
    "has not been found",
  );
  await backend.call(SEARCH_TOOL_NAME, { query: "list issues" });
  await expect(backend.call("list_issues", billing)).rejects.toThrow("cannot be called directly");
  await expect(backend.call(CALL_TOOL_NAME, { arguments: billing })).rejects.toThrow("needs the tool's name");
});

test("a wrong argument inside call_tool is the inner tool's error", async () => {
  const backend = toolSearchBackend(github);
  await backend.call(SEARCH_TOOL_NAME, { query: "get one issue" });
  await expect(
    backend.call(CALL_TOOL_NAME, { name: "get_issue", arguments: { ...billing, issue_number: "1" } }),
  ).rejects.toThrow(/^422 Validation Failed/);
});

test("every tool in the inventory can be found by plain words for what it does", async () => {
  const queries: Record<string, string> = {
    get_repository: "repository details",
    list_branches: "branches",
    list_commits: "commit history",
    get_commit: "one commit diff",
    get_file_contents: "read file contents",
    search_code: "search code",
    list_issues: "issues",
    get_issue: "get one issue",
    list_issue_comments: "comments on an issue",
    search_issues: "search issues and pull requests",
    list_pull_requests: "pull requests",
    get_pull_request: "pull request merge state",
    list_pull_request_files: "files a pull request changes",
    list_releases: "releases",
    list_workflow_runs: "CI workflow runs",
  };
  expect(Object.keys(queries)).toEqual(names(github));
  for (const [tool, query] of Object.entries(queries)) {
    const result = (await toolSearchBackend(github).call(SEARCH_TOOL_NAME, { query })) as Found;
    expect(result.tools.map((found) => found.name), `${tool} by "${query}"`).toContain(tool);
  }
});

test("a search with no match says so, and a missing query is an error", async () => {
  const backend = toolSearchBackend(github);
  expect(await backend.call(SEARCH_TOOL_NAME, { query: "zzz" })).toMatchObject({ tools: [] });
  await expect(backend.call(SEARCH_TOOL_NAME, {})).rejects.toThrow("query");
});

test("each wrapper keeps its own found tools, so one run cannot help the next", async () => {
  const first = toolSearchBackend(github);
  await first.call(SEARCH_TOOL_NAME, { query: "releases" });
  await expect(
    toolSearchBackend(github).call(CALL_TOOL_NAME, { name: "list_releases", arguments: billing }),
  ).rejects.toThrow("has not been found");
});

test("in the harness, a model searches, calls and answers, seeing the same two tools every turn", async () => {
  const offered: string[][] = [];
  const usage = { inputTokens: 1, outputTokens: 1 };
  const script: ModelTurn[] = [
    { text: "", toolCalls: [{ id: "1", name: SEARCH_TOOL_NAME, args: { query: "releases" } }], usage },
    {
      text: "",
      toolCalls: [
        { id: "2", name: CALL_TOOL_NAME, args: { name: "list_releases", arguments: { owner: WORLD_OWNER, repo: "infra-tools", per_page: 1 } } },
      ],
      usage,
    },
    { text: "v1.5.0", toolCalls: [], usage },
  ];
  const provider: ModelProvider = {
    provider: "scripted",
    model: "scripted-1",
    turn(request: TurnRequest) {
      offered.push(request.tools.map((tool) => tool.name));
      return Promise.resolve(script[offered.length - 1] as ModelTurn);
    },
  };
  const task: EvalTask = { id: "t", type: "bounded_tool_heavy", prompt: "latest tag?", check: (answer) => answer === "v1.5.0" };

  const record = await runTask(task, provider, toolSearchBackend(github), { arm: "tool_search" });

  expect(record).toMatchObject({ arm: "tool_search", success: true, turns: 3, toolCalls: 2, toolErrors: 0 });
  expect(offered).toEqual([
    [SEARCH_TOOL_NAME, CALL_TOOL_NAME],
    [SEARCH_TOOL_NAME, CALL_TOOL_NAME],
    [SEARCH_TOOL_NAME, CALL_TOOL_NAME],
  ]);
});
