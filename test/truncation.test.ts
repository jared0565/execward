/**
 * A final value that is too large is cut and returned with a notice (FR-5).
 * Found with real models on 2026-11-23: a cut list of records grew back over
 * the limit once it was sent as a JSON string, because every quote in it was
 * escaped, and the release gate withheld the reply as a sandbox fault.
 */
import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { NOTICE_ALLOWANCE_BYTES } from "../src/code-tool/release-gate";
import { runCodeTool, truncationNotice, type RunHost } from "../src/code-tool/run";
import { codeToolOutputSchema } from "../src/contracts/code-tool";
import type { Executor } from "../src/executor";
import { cutToBytes } from "../src/executor/outcome";
import { RUN_LIMITS } from "../src/limits";

const LIMIT = RUN_LIMITS.maxResultBytes;
const sent = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

const host: RunHost = {
  callTool: async () => ({}),
  search: async () => [],
  describe: async () => ({}),
  provenance: () => ({ dataClass: undefined, records: 0 }),
};

/** An executor that returns what the real one does for an oversized value: its JSON text, cut to the limit. */
function returning(value: unknown): Executor {
  return {
    name: "scripted",
    execute: async (request) => ({ status: "completed", result: cutToBytes(JSON.stringify(value), request.limits.maxResultBytes), logs: [], truncated: true }),
  };
}

async function run(value: unknown) {
  return runCodeTool({ script: "return 1;", project: "work" }, {
    executor: returning(value),
    audit: auditLog(memoryAuditStore(), () => 0),
    hostFor: () => host,
    newRunId: () => "run-1",
    now: () => 0,
  });
}

const records = Array.from({ length: 400 }, (_, n) => ({ number: n, title: `Pull request "${n}"`, state: "closed", user: { login: "someone" }, body: "line one\nline two\\three" }));

describe("a final value that is too large", () => {
  it.each([
    ["a list of records", records],
    ["text that is all quotes", '"'.repeat(LIMIT * 2)],
    ["text that is all backslashes and line breaks", "\\\n".repeat(LIMIT)],
    ["plain text", "x".repeat(LIMIT * 2)],
    ["text in a script that takes several bytes a character", "é中".repeat(LIMIT)],
  ])("is cut, returned with the notice and within the limit as sent: %s", async (_label, value) => {
    const output = await run(value);
    expect(output.status).toBe("completed");
    if (output.status !== "completed") return;
    expect(output.truncated).toBe(true);
    expect(codeToolOutputSchema.safeParse(output).success).toBe(true);
    expect(sent(output.result)).toBeLessThanOrEqual(LIMIT + NOTICE_ALLOWANCE_BYTES);
    const result = output.result as { notice: string; partial: string };
    expect(result.notice).toContain("was cut");
    // It is still the start of what the script returned, and most of the limit is used.
    expect(JSON.stringify(value).startsWith(result.partial)).toBe(true);
    expect(sent(result)).toBeGreaterThan(LIMIT / 3);
  });

  it("cuts no further than it must", () => {
    const text = cutToBytes(JSON.stringify(records), LIMIT);
    const wrapped = truncationNotice(text, LIMIT);
    expect(sent(wrapped)).toBeLessThanOrEqual(LIMIT);
    expect(sent(wrapped)).toBeGreaterThan(LIMIT - 64);
    // Plain text needs no second cut beyond making room for the notice.
    const plain = truncationNotice("x".repeat(LIMIT), LIMIT);
    expect(sent(plain)).toBeLessThanOrEqual(LIMIT);
    expect(sent(plain)).toBeGreaterThan(LIMIT - 8);
  });

  it("leaves a value that is not text as it is", () => {
    expect(truncationNotice({ a: 1 }, LIMIT).partial).toEqual({ a: 1 });
  });
});
