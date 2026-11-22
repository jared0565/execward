import { expect, test } from "vitest";

// Probe for task 0.2.1. It fails only on GitHub Actions, so it shows what GitHub
// does with a red run without bypassing the local gate. This branch must never merge.
test("probe: fails on GitHub Actions only", () => {
  expect(process.env.GITHUB_ACTIONS).not.toBe("true");
});
