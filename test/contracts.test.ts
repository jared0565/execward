import { describe, expect, test } from "vitest";
import {
  CONTRACT_VERSION,
  ERROR_CODES,
  UNCLASSIFIED_TOOL_POLICY,
  codeToolInputSchema,
  codeToolOutputSchema,
  isRetryable,
  policyRecordSchema,
  scriptMayCall,
  toolPath,
  type ErrorCode,
} from "../src/contracts";
import { SCRIPT_LIMITS } from "../src/limits";

const HASH = "a".repeat(64);

const report = {
  runId: "run-1",
  scriptHash: HASH,
  callsByTool: { github_list_issues: 2 },
  recordsRead: 40,
  recordsWritten: 0,
  errors: [],
  retries: 0,
  assertions: { passed: 1, failed: 0 },
  sideEffects: [],
  verification: "not_applicable",
  durationMs: 812,
};

test("the contracts carry a semantic version", () => {
  expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

describe("contract 1: code tool input", () => {
  test("accepts a script and a project", () => {
    const parsed = codeToolInputSchema.safeParse({ script: "return 1", project: "demo" });
    expect(parsed.success).toBe(true);
  });

  test("refuses a missing project, an empty script and unknown fields", () => {
    expect(codeToolInputSchema.safeParse({ script: "return 1" }).success).toBe(false);
    expect(codeToolInputSchema.safeParse({ script: "", project: "demo" }).success).toBe(false);
    expect(
      codeToolInputSchema.safeParse({ script: "return 1", project: "demo", sudo: true }).success,
    ).toBe(false);
  });

  test("refuses a script over the size cap", () => {
    const script = "x".repeat(SCRIPT_LIMITS.maxScriptBytes + 1);
    expect(codeToolInputSchema.safeParse({ script, project: "demo" }).success).toBe(false);
  });
});

describe("contract 2: code tool output", () => {
  test("accepts each of the four statuses in its own shape", () => {
    const error = { code: "policy_denied", message: "github_delete_repo is direct-only" };
    const outputs = [
      { status: "completed", result: { open: 3 }, truncated: false, report },
      { status: "paused", escalation_id: "esc-1", report },
      { status: "error", error: { code: "timeout", message: "wall-clock limit" }, report },
      { status: "refused", error, report },
    ];
    for (const output of outputs) {
      expect(codeToolOutputSchema.safeParse(output).success, output.status).toBe(true);
    }
  });

  test("refuses a status outside the four, and a paused run with no escalation id", () => {
    expect(codeToolOutputSchema.safeParse({ status: "ok", result: 1, report }).success).toBe(false);
    expect(codeToolOutputSchema.safeParse({ status: "paused", report }).success).toBe(false);
  });

  test("refuses an error code outside the fixed set", () => {
    const output = { status: "error", error: { code: "oops", message: "?" }, report };
    expect(codeToolOutputSchema.safeParse(output).success).toBe(false);
  });
});

describe("contract 3: sandbox API", () => {
  test("derives sanitised tool paths", () => {
    expect(toolPath("my-server", "list-items")).toBe("my_server_list_items");
    expect(toolPath("github", "list_issues")).toBe("github_list_issues");
  });

  test("refuses names that leave nothing usable", () => {
    expect(() => toolPath("---", "list")).toThrow();
    expect(() => toolPath("github", "")).toThrow();
    expect(() => toolPath("9lives", "list")).toThrow();
  });
});

describe("contract 4: policy record", () => {
  const record = {
    server: "github",
    tool: "list_issues",
    definitionHash: HASH,
    callerRule: "both",
    dataClass: "internal",
    tier: 0,
    sensitive: false,
    outbound: false,
    destinationAllowlist: [],
    quotas: {},
  };

  test("accepts a complete record", () => {
    expect(policyRecordSchema.safeParse(record).success).toBe(true);
  });

  test("refuses a record missing a field, or with a tier or class outside the set", () => {
    const noTier: Record<string, unknown> = { ...record };
    delete noTier.tier;
    expect(policyRecordSchema.safeParse(noTier).success).toBe(false);
    expect(policyRecordSchema.safeParse({ ...record, tier: 3 }).success).toBe(false);
    expect(policyRecordSchema.safeParse({ ...record, dataClass: "secret" }).success).toBe(false);
  });

  test("an unclassified tool is direct-only, tier 2 and the highest data class", () => {
    expect(UNCLASSIFIED_TOOL_POLICY.tier).toBe(2);
    expect(UNCLASSIFIED_TOOL_POLICY.dataClass).toBe("client_personal");
    expect(scriptMayCall(UNCLASSIFIED_TOOL_POLICY)).toBe(false);
    expect(scriptMayCall({ callerRule: "both" })).toBe(true);
  });
});

describe("contract 5: error codes", () => {
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];

  test("includes every code the PRD names", () => {
    const named = [
      "policy_denied",
      "schema_invalid",
      "assertion_failed",
      "quota_exceeded",
      "timeout",
      "upstream_error",
      "definition_changed",
      "static_check_failed",
    ];
    for (const code of named) expect(codes).toContain(code);
  });

  test("no security code is retryable", () => {
    for (const code of codes) {
      if (ERROR_CODES[code].security) expect(isRetryable(code), code).toBe(false);
    }
  });

  test("the failures FR-41 excludes from retry are all security codes", () => {
    const excluded: ErrorCode[] = [
      "policy_denied",
      "injection_suspected",
      "quota_exceeded",
      "circuit_open",
      "static_check_failed",
      "definition_changed",
    ];
    for (const code of excluded) expect(ERROR_CODES[code].security, code).toBe(true);
  });

  test("a sandbox fault is never retried", () => {
    expect(isRetryable("sandbox_fault")).toBe(false);
  });
});
