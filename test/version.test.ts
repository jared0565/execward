import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { EXECWARD_VERSION } from "../src/index";

test("the exported version is the one in package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(EXECWARD_VERSION).toBe(pkg.version);
  expect(EXECWARD_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
