/**
 * A script chooses the names of the tools it calls. Names that every ordinary
 * object already has ("toString", "constructor") must be counted like any
 * other, not break the reply. Found on Cloudflare, 2026-11-23: `String(tools)`
 * calls tools named toString and valueOf, and the run ended as a sandbox fault.
 */
import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { runCodeTool, type RunHost } from "../src/code-tool/run";
import { codeToolOutputSchema } from "../src/contracts/code-tool";
import type { Executor } from "../src/executor";
import { metricFor } from "../src/metrics/metrics";

const NAMES = ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__", "isPrototypeOf", "toLocaleString"];

const refusing: RunHost = {
  async callTool(path) {
    throw new Error(`no tool named ${path}`);
  },
  search: async () => [],
  describe: async () => ({}),
  provenance: () => ({ dataClass: undefined, records: 0 }),
};

function calling(names: readonly string[]): Executor {
  return {
    name: "scripted",
    async execute(request) {
      for (const name of names) await request.host.callTool(name, {}).catch(() => undefined);
      return { status: "completed", result: "done", logs: [], truncated: false };
    },
  };
}

async function run(names: readonly string[]) {
  return runCodeTool({ script: "return 1;", project: "work" }, {
    executor: calling(names),
    audit: auditLog(memoryAuditStore(), () => 0),
    hostFor: () => refusing,
    newRunId: () => "run-1",
    now: () => 0,
  });
}

describe("tool names that every object already has", () => {
  it("counts a call to each as one call, and the reply still matches the output contract", async () => {
    const output = await run([...NAMES, "toString"]);
    expect(output.status).toBe("completed");
    expect(codeToolOutputSchema.safeParse(output).success).toBe(true);
    const counts = output.report.callsByTool;
    for (const name of NAMES) expect(Object.getOwnPropertyDescriptor(counts, name)?.value, name).toBe(name === "toString" ? 2 : 1);
    expect(Object.keys(counts).sort()).toEqual([...NAMES].sort());
  });

  it("survives being written as JSON and read back", async () => {
    const output = await run(NAMES);
    const back = JSON.parse(JSON.stringify(output)) as typeof output;
    expect(codeToolOutputSchema.safeParse(back).success).toBe(true);
    expect(Object.keys(back.report.callsByTool).length).toBe(NAMES.length);
  });

  it("adds up to the right total in the run's metric", async () => {
    const output = await run(NAMES);
    expect(metricFor(output, "work").toolCalls).toBe(NAMES.length);
  });
});
