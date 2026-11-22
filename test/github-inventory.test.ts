import { expect, test } from "vitest";
import { policyRecordSchema, scriptMayCall, toolPath } from "../src/contracts";
import { GITHUB_READ_ONLY_TOOLS } from "../src/tools/github-inventory";

const draftSchema = policyRecordSchema.omit({ definitionHash: true });

test("every action has a complete draft policy record", () => {
  expect(GITHUB_READ_ONLY_TOOLS.length).toBeGreaterThan(0);
  for (const entry of GITHUB_READ_ONLY_TOOLS) {
    const { endpoint, summary, ...draft } = entry;
    expect(draftSchema.safeParse(draft).success, entry.tool).toBe(true);
    expect(summary.length, entry.tool).toBeGreaterThan(0);
    expect(endpoint, entry.tool).toMatch(/^GET \//);
  }
});

test("every action is read-only: tier 0, a GET, and not outbound", () => {
  for (const entry of GITHUB_READ_ONLY_TOOLS) {
    expect(entry.tier, entry.tool).toBe(0);
    expect(entry.outbound, entry.tool).toBe(false);
    expect(entry.destinationAllowlist, entry.tool).toEqual([]);
    expect(scriptMayCall(entry), entry.tool).toBe(true);
  }
});

test("tool names are unique and give valid script function names", () => {
  const paths = GITHUB_READ_ONLY_TOOLS.map((entry) => toolPath(entry.server, entry.tool));
  expect(new Set(paths).size).toBe(paths.length);
  for (const path of paths) expect(path).toMatch(/^github_[a-z_]+$/);
});

test("anything that returns code or free text is confidential and sensitive", () => {
  const returnsContent = [
    "get_commit",
    "get_file_contents",
    "search_code",
    "get_issue",
    "list_issue_comments",
    "search_issues",
    "get_pull_request",
    "list_pull_request_files",
  ];
  for (const name of returnsContent) {
    const entry = GITHUB_READ_ONLY_TOOLS.find((candidate) => candidate.tool === name);
    expect(entry, name).toBeDefined();
    expect(entry?.dataClass, name).toBe("confidential");
    expect(entry?.sensitive, name).toBe(true);
  }
});

test("no action is classed public: a private repository's metadata is internal", () => {
  for (const entry of GITHUB_READ_ONLY_TOOLS) {
    expect(entry.dataClass, entry.tool).not.toBe("public");
  }
});
