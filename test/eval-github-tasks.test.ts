import { expect, test } from "vitest";
import { githubFixtureBackend } from "../src/eval/fixtures/github-backend";
import { buildWorld, WORLD_OWNER } from "../src/eval/fixtures/world";
import { buildGithubTasks } from "../src/eval/tasks/github-tasks";

const world = buildWorld();
const tasks = buildGithubTasks(world);
const backend = githubFixtureBackend(world);
const byId = (id: string) => {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
};

test("the suite has 20 to 40 tasks of both types, each with its own id", () => {
  expect(tasks.length).toBeGreaterThanOrEqual(20);
  expect(tasks.length).toBeLessThanOrEqual(40);
  expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
  const exploratory = tasks.filter((task) => task.type === "exploratory").length;
  expect(exploratory).toBeGreaterThanOrEqual(8);
  expect(tasks.length - exploratory).toBeGreaterThanOrEqual(12);
});

test("every check accepts its own expected answer, also inside a sentence", () => {
  for (const task of tasks) {
    expect(task.expected, task.id).toBeDefined();
    expect(task.check(task.expected ?? ""), task.id).toBe(true);
    expect(task.check(`The answer is ${task.expected}.`), task.id).toBe(true);
  }
});

test("every check rejects an empty answer, a refusal to answer and a wrong value", () => {
  for (const task of tasks) {
    expect(task.check(""), task.id).toBe(false);
    expect(task.check("I could not find that."), task.id).toBe(false);
    expect(task.check("987654"), task.id).toBe(false);
    expect(task.check("nobody-here"), task.id).toBe(false);
  }
});

test("a number check does not pass on an answer that also names another number", () => {
  const task = byId("open-issues-billing");
  expect(task.check(`${task.expected} of 48`)).toBe(false);
  expect(task.check(`either ${task.expected} or ${Number(task.expected) + 1}`)).toBe(false);
});

test("a name check does not pass on an answer that names every candidate", () => {
  expect(byId("top-commit-author-infra").check(world.users.join(", "))).toBe(false);
  expect(byId("public-repo").check("billing-api, web-dashboard, infra-tools")).toBe(false);
});

test("expected answers can be reached through the tools, not only from the raw data", async () => {
  const owner = WORLD_OWNER;
  type Row = Record<string, unknown>;

  const open = (await backend.call("list_issues", { owner, repo: "billing-api", per_page: 100 })) as Row[];
  expect(String(open.filter((issue) => !("pull_request" in issue)).length)).toBe(byId("open-issues-billing").expected);

  const failed = (await backend.call("list_workflow_runs", { owner, repo: "billing-api", status: "failure" })) as Row;
  expect(String(failed["total_count"])).toBe(byId("failed-runs-billing").expected);

  const merged = (await backend.call("search_issues", { q: `repo:${owner}/billing-api is:pr is:merged` })) as Row;
  expect(String(merged["total_count"])).toBe(byId("merged-pulls-billing").expected);

  const touching = (await backend.call("list_commits", { owner, repo: "billing-api", path: "src/invoice.ts", per_page: 100 })) as Row[];
  expect(String(touching.length)).toBe(byId("commits-touching-invoice").expected);

  const code = (await backend.call("search_code", { q: "MAX_RETRIES" })) as { items: { text_matches: { fragment: string }[] }[] };
  // Lines that only use the constant are matches too; keep the ones that define it.
  const values = code.items
    .flatMap((item) => item.text_matches)
    .flatMap((match) => /MAX_RETRIES = (\d+)/.exec(match.fragment)?.[1] ?? [])
    .map(Number);
  expect(values).toHaveLength(3);
  expect(String(values.reduce((total, value) => total + value, 0))).toBe(byId("retries-sum").expected);
});

test("no expected answer is zero or empty, which a model could reach by doing nothing", () => {
  for (const task of tasks) {
    expect(task.expected, task.id).not.toBe("0");
    expect(task.expected, task.id).not.toBe("");
  }
});
