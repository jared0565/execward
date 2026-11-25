import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { HELD_NOTICE, runCodeTool, type CodeToolDeps, type RunHost } from "../src/code-tool/run";
import { CODE_TOOL_DESCRIPTION } from "../src/code-tool/description";
import { queueItemView } from "../src/console/http";
import { memoryControlStore } from "../src/console/control";
import { escalationQueue, memoryEscalationStore } from "../src/console/escalations";
import { codeToolOutputSchema } from "../src/contracts/code-tool";
import { SANDBOX_GLOBALS } from "../src/contracts/sandbox-api";
import type { DataClass } from "../src/contracts/policy";
import type { ExecutionOutcome, Executor } from "../src/executor";
import { interpretReport, MAX_DECLARATION_CHARS, UNREADABLE_DECLARATION } from "../src/executor/outcome";
import { CROSS_CHECK_LIMITS, RUN_LIMITS } from "../src/limits";
import { crossCheck, figuresAgree, recompute } from "../src/verify/cross-check";

const figure = (over: Record<string, unknown> = {}) => ({ name: "invoice total", value: 6, op: "sum", rows: [1, 2, 3], ...over });

describe("working a critical figure out again (task 2.2.2, FR-43)", () => {
  it.each([
    ["sum", [1, 2, 3.5], 6.5],
    ["count", [4, 4, 4], 3],
    ["min", [3, -1, 2], -1],
    ["max", [3, -1, 2], 3],
    ["average", [1, 2, 6], 3],
    ["sum", [], 0],
    ["count", [], 0],
  ] as const)("the %s of %j is %d", (op, rows, expected) => {
    expect(recompute(op, rows)).toBe(expected);
  });

  it("has no smallest, largest or average of no numbers", () => {
    for (const op of ["min", "max", "average"] as const) expect(recompute(op, [])).toBeUndefined();
  });

  it("adds without losing small numbers beside large ones, whatever the order", () => {
    expect(recompute("sum", [1e16, 1, -1e16])).toBe(1);
    expect(recompute("sum", [1, 1e16, -1e16])).toBe(1);
  });

  it("does not call the last binary places of a sum a disagreement, and does call a penny one", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(figuresAgree(0.1 + 0.2, 0.3)).toBe(true);
    expect(figuresAgree(1234.56, 1234.57)).toBe(false);
    expect(figuresAgree(99_999_999.99, 99_999_999.98)).toBe(false);
    expect(figuresAgree(999_999_999.99, 999_999_999.98)).toBe(false);
    // Ten thousand amounts added in two different orders still agree.
    const amounts = Array.from({ length: 10_000 }, (_unused, index) => 1_000_000 + index * 0.37);
    const forwards = amounts.reduce((total, amount) => total + amount, 0);
    const backwards = [...amounts].reverse().reduce((total, amount) => total + amount, 0);
    expect(figuresAgree(forwards, recompute("sum", amounts) as number)).toBe(true);
    expect(figuresAgree(backwards, recompute("sum", amounts) as number)).toBe(true);
    expect(figuresAgree(0, 0.01)).toBe(false);
  });

  it("agrees with a right figure and disagrees with a wrong one", () => {
    expect(crossCheck([figure()])).toEqual({ ok: true, figures: [{ name: "invoice total", op: "sum", rows: 3, declared: 6, recomputed: 6, agrees: true }] });
    // Text joined to text in place of numbers added: "1" + "2" + "3".
    expect(crossCheck([figure({ value: 123 })])).toEqual({ ok: true, figures: [{ name: "invoice total", op: "sum", rows: 3, declared: 123, recomputed: 6, agrees: false }] });
  });

  it.each([
    ["no list at all", undefined],
    ["the marker for a declaration that could not be read", UNREADABLE_DECLARATION],
    ["a figure that is not an object", [7]],
    ["a figure with no name", [figure({ name: "" })]],
    ["a name that is too long", [figure({ name: "x".repeat(CROSS_CHECK_LIMITS.maxNameChars + 1) })]],
    ["a value that is not a number", [figure({ value: "6" })]],
    ["a value JSON could not carry", [figure({ value: null })]],
    ["an unknown calculation", [figure({ op: "median" })]],
    ["a calculation named like an object's own member", [figure({ op: "constructor" })]],
    ["rows that are not a list", [figure({ rows: "1,2,3" })]],
    ["a row that is not a number", [figure({ rows: [1, "2", 3] })]],
    ["the average of no rows", [figure({ op: "average", rows: [] })]],
    ["too many figures", Array.from({ length: CROSS_CHECK_LIMITS.maxFigures + 1 }, () => figure())],
    ["too many rows", [figure({ rows: Array.from({ length: CROSS_CHECK_LIMITS.maxRows + 1 }, () => 1) })]],
  ])("never treats %s as an agreement", (_label, declared) => {
    expect(crossCheck(declared)).toMatchObject({ ok: false });
  });
});

describe("what the sandbox reports about critical figures is untrusted", () => {
  const base = { status: "completed", resultJson: "1", globalsLeft: [], logs: [] };

  it("passes a declaration on for the core to check", () => {
    expect(interpretReport({ ...base, criticalJson: JSON.stringify([figure()]) }, RUN_LIMITS)).toMatchObject({ status: "completed", critical: [figure()] });
  });

  it("leaves it out when nothing was declared", () => {
    expect(interpretReport(base, RUN_LIMITS)).not.toHaveProperty("critical");
  });

  it.each([
    ["is not text", null],
    ["is not JSON", "[{oops"],
    ["is too large", `[${" ".repeat(MAX_DECLARATION_CHARS)}]`],
  ])("marks a declaration that %s as unreadable, and does not drop it", (_label, criticalJson) => {
    const outcome = interpretReport({ ...base, criticalJson }, RUN_LIMITS);
    expect(outcome).toMatchObject({ status: "completed", critical: UNREADABLE_DECLARATION });
    expect(crossCheck((outcome as { critical?: unknown }).critical)).toMatchObject({ ok: false });
  });
});

function host(dataClass: DataClass | undefined = undefined): RunHost {
  return { callTool: async () => ({}), search: async () => [], describe: async () => ({}), provenance: () => ({ dataClass, records: 0 }) };
}

function setup(critical: unknown, options: { readonly dataClass?: DataClass; readonly hook?: CodeToolDeps["onCrossCheckDisagreement"] | "none" } = {}) {
  const store = memoryAuditStore();
  const held: Parameters<NonNullable<CodeToolDeps["onCrossCheckDisagreement"]>>[0][] = [];
  const outcome: ExecutionOutcome = { status: "completed", result: { total: 6, secret: "from the script" }, logs: ["a log line"], truncated: false, ...(critical === undefined ? {} : { critical }) };
  const executor: Executor = { name: "scripted", execute: async () => outcome };
  const hook: CodeToolDeps["onCrossCheckDisagreement"] =
    options.hook === "none"
      ? undefined
      : (options.hook ??
        (async (input) => {
          held.push(input);
          return "esc-1";
        }));
  const deps: CodeToolDeps = {
    executor,
    audit: auditLog(store, () => 0),
    hostFor: () => host(options.dataClass),
    newRunId: () => "run-1",
    now: () => 0,
    allowedDataClass: () => "internal",
    ...(hook ? { onCrossCheckDisagreement: hook } : {}),
  };
  return { deps, store, held };
}

const INPUT = { script: "return 1;", project: "demo" };

describe("the cross-check in the run path", () => {
  it("lets a result through when every declared figure agrees, and counts them in the report", async () => {
    const { deps, held } = setup([figure(), figure({ name: "rows", op: "count", value: 3 })]);
    const output = await runCodeTool(INPUT, deps);
    expect(output).toMatchObject({ status: "completed", result: { total: 6 }, report: { crossChecks: { agreed: 2, disagreed: 0 } } });
    expect(held).toEqual([]);
    expect(codeToolOutputSchema.safeParse(output).success).toBe(true);
  });

  it("says nothing about cross-checks when none was declared", async () => {
    const output = await runCodeTool(INPUT, setup(undefined).deps);
    expect(output.status).toBe("completed");
    expect(output.report).not.toHaveProperty("crossChecks");
  });

  it("holds the result when a figure disagrees: nothing the script wrote goes back, and the owner is asked", async () => {
    const { deps, held } = setup([figure(), figure({ name: "tax", value: 123 })]);
    const output = await runCodeTool(INPUT, deps);
    expect(output).toEqual({ status: "paused", escalation_id: "esc-1", notices: [HELD_NOTICE], report: expect.objectContaining({ crossChecks: { agreed: 1, disagreed: 1 }, verification: "not_applicable" }) });
    expect(JSON.stringify(output)).not.toContain("from the script");
    expect(JSON.stringify(output)).not.toContain("a log line");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ runId: "run-1", project: "demo" });
    // The owner is given every figure, with both values.
    expect(held[0]?.figures).toEqual([
      { name: "invoice total", op: "sum", rows: 3, declared: 6, recomputed: 6, agrees: true },
      { name: "tax", op: "sum", rows: 3, declared: 123, recomputed: 6, agrees: false },
    ]);
    expect(codeToolOutputSchema.safeParse(output).success).toBe(true);
  });

  it.each([
    ["there is no queue", "none" as const],
    [
      "the queue fails",
      async () => {
        throw new Error("queue down");
      },
    ],
    ["the queue gives no ID", async () => ""],
  ])("still withholds a disagreeing result when %s", async (_label, hook) => {
    const output = await runCodeTool(INPUT, setup([figure({ value: 7 })], { hook }).deps);
    expect(output).toMatchObject({ status: "error", error: { code: "assertion_failed" } });
    expect(JSON.stringify(output)).not.toContain("from the script");
  });

  it("returns an error the model can fix when a declaration cannot be checked", async () => {
    const { deps, held } = setup([figure({ op: "median" })]);
    const output = await runCodeTool(INPUT, deps);
    expect(output).toMatchObject({ status: "error", error: { code: "script_error" } });
    expect((output as { error: { message: string } }).error.message).toContain("could not be checked");
    expect(JSON.stringify(output)).not.toContain("from the script");
    expect(held).toEqual([]);
  });

  it("records both values of every figure in the audit log", async () => {
    const { deps, store } = setup([figure({ value: 7 })]);
    await runCodeTool(INPUT, deps);
    const finished = store.entries.find((entry) => entry.kind === "run_finished");
    // The entry's content is itself JSON text, so its quotes may be escaped.
    const text = JSON.stringify(finished).replaceAll(String.fromCharCode(92), "");
    expect(text).toContain('"recomputed":6');
    expect(text).toContain('"declared":7');
  });

  it("withholds the counts with the content when the run read data above the project's class", async () => {
    const agreed = await runCodeTool(INPUT, setup([figure()], { dataClass: "confidential" }).deps);
    expect(agreed).toMatchObject({ status: "completed", masked: true });
    expect(agreed.report).not.toHaveProperty("crossChecks");

    const { deps, held } = setup([figure({ value: 7 })], { dataClass: "confidential" });
    const disagreed = await runCodeTool(INPUT, deps);
    expect(disagreed.status).toBe("paused");
    expect(disagreed.report).not.toHaveProperty("crossChecks");
    expect(held).toHaveLength(1);
  });
});

describe("a disagreement in the owner's queue", () => {
  it("is raised with the PRD's four options, recommends the server's own figure, and shows both values", async () => {
    const queue = escalationQueue({ store: memoryEscalationStore(), control: memoryControlStore(), audit: auditLog(memoryAuditStore(), () => 0), now: () => 1_000, newId: () => "esc-9" });
    const figures = [{ name: "tax", op: "sum" as const, rows: 3, declared: 123, recomputed: 6, agrees: false }];
    const item = await queue.raise({ trigger: "cross_check_disagreement", project: "demo", runId: "run-1", figures, context: { deterministicResultExists: true } });
    expect(item.options.map((option) => option.id)).toEqual(["discard_both", "show_both", "rerun_stricter", "use_deterministic"]);
    expect(item.recommended.optionId).toBe("use_deterministic");
    expect(item.safeAction).toBe("Result held");
    expect(item.expiresAt).toBe(1_000 + 24 * 60 * 60 * 1000);
    expect(queueItemView(item).figures).toEqual(figures);
  });

  it("shows no figures on an item that has none", async () => {
    const queue = escalationQueue({ store: memoryEscalationStore(), control: memoryControlStore(), audit: auditLog(memoryAuditStore(), () => 0), now: () => 1_000, newId: () => "esc-9" });
    const item = await queue.raise({ trigger: "repeated_failure", project: "demo" });
    expect(queueItemView(item)).not.toHaveProperty("figures");
  });
});

describe("what a script and a model are told", () => {
  it("offers critical() in the sandbox and names it in the tool's description", () => {
    expect(SANDBOX_GLOBALS).toContain("critical");
    expect(CODE_TOOL_DESCRIPTION).toContain("critical(name, n, { op: 'sum', rows })");
  });
});
