/**
 * The adversarial suite against ExecWard itself, on the deployed test Worker,
 * where the sandbox is Cloudflare's own (FR-31, Gate 1). Run with `npm run test:deployed`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADVERSARIAL_CASES, JUDGED_FROM_THE_BUILD, OPEN_UNTIL_LATER } from "../../src/adversarial";
import { unexpected, type ObservedResult } from "../../src/adversarial/expected";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

describe("the adversarial suite against ExecWard on Cloudflare (FR-31, Gate 1)", { timeout: 120_000 }, () => {
  it("defends every attack on a part that exists, serves both controls, and leaves open only the listed later parts", async () => {
    const response = await fetch(`${setting("EXECWARD_TEST_URL", "test-worker-url")}/adversarial`, {
      method: "POST",
      headers: { authorization: `Bearer ${setting("EXECWARD_TEST_SECRET", "test-worker-secret")}` },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: ObservedResult[] };
    expect(results).toHaveLength(ADVERSARIAL_CASES.length - JUDGED_FROM_THE_BUILD.length);
    expect(unexpected(results)).toEqual([]);
    expect(results.filter((result) => result.kind === "control" && result.defended)).toHaveLength(2);
    expect(
      results
        .filter((result) => result.kind === "attack" && !result.defended)
        .map((result) => result.id)
        .sort(),
    ).toEqual(Object.keys(OPEN_UNTIL_LATER).sort());
  });
});
