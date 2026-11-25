import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { GITHUB_API, GITHUB_API_VERSION, githubPinsAndPolicy } from "../src/connectors/github";

/**
 * Task G.2: the upstream server list is updated on every add or change. This holds the
 * list to the code, so a tool that is added, removed or redefined cannot merge with the
 * list left as it was.
 */
const list = readFileSync(new URL("../docs/governance/upstream-servers.md", import.meta.url), "utf8");

function toolRows(): string[][] {
  const start = list.indexOf("## Approved tools and their definition hashes");
  const end = list.indexOf("\n## ", start + 1);
  expect(start).toBeGreaterThan(-1);
  return list
    .slice(start, end === -1 ? undefined : end)
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/`/g, "")));
}

test("the upstream server list names every GitHub tool with the hash the code pins", async () => {
  const { pins, records } = await githubPinsAndPolicy();
  const expected = pins.map((pin, index) => {
    const record = records[index];
    if (!record) throw new Error(`no policy record for "${pin.path}"`);
    return [pin.path, record.server, String(record.tier), record.dataClass, pin.hash];
  });
  // Every row carries a sixth cell, the approval date; the first five are compared.
  const rows = toolRows();
  expect(rows.map((row) => row.slice(0, 5))).toEqual(expected);
  for (const row of rows) expect(row[5]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("the upstream server list names the pinned API version and host", () => {
  expect(list).toContain(`REST API version \`${GITHUB_API_VERSION}\``);
  expect(list).toContain(`\`${new URL(GITHUB_API).host}\``);
});
