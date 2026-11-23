import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { brokerHost, type Upstream } from "../src/broker/broker";
import { effectivePolicy, memoryPolicyStore, pathOf, PolicyStoreError, type PolicyStore } from "../src/broker/policy-store";
import { runCodeTool } from "../src/code-tool/run";
import type { Executor } from "../src/executor";
import { record } from "./fixtures/policy";

/** These tests are about caller rules, so the tools accept any arguments. */
const ANY_ARGUMENTS = { description: "test tool", inputSchema: { type: "object", additionalProperties: true } };

const RECORDS = [
  record("list_issues"),
  record("get_issue", { callerRule: "script" }),
  record("delete_repo", { callerRule: "direct", tier: 2 }),
  record("create_issue", { tier: 1 }),
  record("merge_pull_request", { tier: 2 }),
];

function broker(store: PolicyStore = memoryPolicyStore(RECORDS)) {
  const upstreamCalls: { tool: string; args: unknown }[] = [];
  const upstream: Upstream = async ({ record: called, args }) => {
    upstreamCalls.push({ tool: called.tool, args });
    return { ok: called.tool };
  };
  return { host: brokerHost({ store, upstream, definitionFor: async () => ANY_ARGUMENTS }), upstreamCalls };
}

describe("the policy store (FR-50)", () => {
  it("treats a tool with no record as the highest data class, tier 2 and direct-only", () => {
    expect(effectivePolicy(undefined)).toEqual({
      classified: false,
      callerRule: "direct",
      dataClass: "client_personal",
      tier: 2,
      sensitive: true,
      outbound: true,
    });
  });

  it("returns a stored record by its tool path", async () => {
    const store = memoryPolicyStore(RECORDS);
    expect(await store.get("github_list_issues")).toMatchObject({ tool: "list_issues", tier: 0 });
    expect(await store.get("github_unknown")).toBeUndefined();
    expect((await store.list()).map(pathOf)).toContain("github_merge_pull_request");
  });

  it("refuses a record that does not match the contract, or a second record for the same path", () => {
    expect(() => memoryPolicyStore([{ ...record("x"), tier: 7 }])).toThrow(PolicyStoreError);
    expect(() => memoryPolicyStore([{ ...record("x"), extra: true }])).toThrow(PolicyStoreError);
    expect(() => memoryPolicyStore([record("list-issues"), record("list_issues")])).toThrow(PolicyStoreError);
  });
});

describe("the broker's caller rules (FR-6, FR-13)", () => {
  it("forwards a call to a tier-0 tool a script may call", async () => {
    const { host, upstreamCalls } = broker();
    expect(await host.callTool("github_list_issues", { page: 1 })).toEqual({ ok: "list_issues" });
    expect(await host.callTool("github_get_issue", { number: 7 })).toEqual({ ok: "get_issue" });
    expect(upstreamCalls).toEqual([
      { tool: "list_issues", args: { page: 1 } },
      { tool: "get_issue", args: { number: 7 } },
    ]);
    expect(host.securityError()).toBeUndefined();
  });

  it.each([
    ["a tool with no record", "github_unknown_tool", "the tool has no policy record"],
    ["a direct-only tool", "github_delete_repo", "the tool may only be called directly, not from a script"],
    ["a tier-1 tool", "github_create_issue", "tier 1 tools cannot be called from a script yet"],
    ["a tier-2 tool", "github_merge_pull_request", "tier 2 tools cannot be called from a script yet"],
    ["a name that is not a tool path", "constructor", "the tool has no policy record"],
  ])("refuses %s with policy_denied and makes no upstream call", async (_label, path, reason) => {
    const { host, upstreamCalls } = broker();
    await expect(host.callTool(path, { secret: "do not log me" })).rejects.toThrow(`policy_denied: ${reason}`);
    expect(upstreamCalls).toEqual([]);
    expect(host.securityError()).toEqual({ code: "policy_denied", message: `the call to "${path}" was refused: ${reason}` });
    expect(JSON.stringify(host.denials)).not.toContain("do not log me");
  });

  it("ends the run at the first refusal: later calls are refused too", async () => {
    const { host, upstreamCalls } = broker();
    await host.callTool("github_list_issues", {});
    await expect(host.callTool("github_delete_repo", {})).rejects.toThrow("policy_denied");
    await expect(host.callTool("github_list_issues", {})).rejects.toThrow("the run was ended by an earlier refusal");
    await expect(host.search("issues")).rejects.toThrow("policy_denied");
    await expect(host.describe("github_list_issues")).rejects.toThrow("policy_denied");
    expect(upstreamCalls.length).toBe(1);
    expect(host.denials.length).toBe(4);
    expect(host.securityError()?.message).toContain("github_delete_repo");
  });

  it("fails closed when the policy table cannot be read", async () => {
    const down: PolicyStore = {
      get: async () => Promise.reject(new PolicyStoreError("connection string: do-not-leak")),
      list: async () => Promise.reject(new PolicyStoreError("down")),
    };
    const first = broker(down);
    await expect(first.host.callTool("github_list_issues", {})).rejects.toThrow("policy_denied: the policy table is unavailable");
    expect(first.upstreamCalls).toEqual([]);
    expect(JSON.stringify(first.host.securityError())).not.toContain("do-not-leak");
    await expect(broker(down).host.search("issues")).rejects.toThrow("policy_denied");
  });

  it("lets search and describe show only what a script could call", async () => {
    const { host } = broker();
    expect(await host.search("")).toEqual(["github_get_issue", "github_list_issues"]);
    expect(await host.search("list ISSUES")).toEqual(["github_list_issues"]);
    expect(await host.describe("github_list_issues")).toEqual({ path: "github_list_issues", server: "github", tool: "list_issues", tier: 0, dataClass: "internal" });
    await expect(host.describe("github_delete_repo")).rejects.toThrow('no tool named "github_delete_repo" is available to scripts');
    await expect(host.describe("github_nothing")).rejects.toThrow("is available to scripts");
    // Asking about a name is not an attempt to use it.
    expect(host.securityError()).toBeUndefined();
  });

  it("keeps each run's broker separate", async () => {
    const store = memoryPolicyStore(RECORDS);
    const upstream: Upstream = async () => "ok";
    const one = brokerHost({ store, upstream, definitionFor: async () => ANY_ARGUMENTS });
    const two = brokerHost({ store, upstream, definitionFor: async () => ANY_ARGUMENTS });
    await expect(one.callTool("github_delete_repo", {})).rejects.toThrow();
    expect(await two.callTool("github_list_issues", {})).toBe("ok");
  });
});

describe("a refusal ends the run at the code tool (FR-41)", () => {
  it("reports policy_denied even when the script caught the refusal and returned a value", async () => {
    const { host, upstreamCalls } = broker();
    // Stands in for a script that swallows the error and carries on.
    const executor: Executor = {
      name: "scripted",
      async execute(request) {
        await request.host.callTool("github_list_issues", {});
        await request.host.callTool("github_delete_repo", {}).catch(() => undefined);
        await request.host.callTool("github_list_issues", {}).catch(() => undefined);
        return { status: "completed", result: "carried on", logs: ["after the refusal"], truncated: false };
      },
    };
    let clock = 0;
    const output = await runCodeTool(
      { script: "return 1;", project: "demo" },
      { executor, audit: auditLog(memoryAuditStore(), () => 0), hostFor: () => host, newRunId: () => "run-1", now: () => (clock += 10) },
    );
    expect(output).toMatchObject({
      status: "error",
      error: { code: "policy_denied", message: 'the call to "github_delete_repo" was refused: the tool may only be called directly, not from a script' },
      report: { callsByTool: { github_list_issues: 2, github_delete_repo: 1 }, errors: [{ code: "policy_denied" }] },
    });
    expect(JSON.stringify(output)).not.toContain("carried on");
    expect(JSON.stringify(output)).not.toContain("after the refusal");
    expect(upstreamCalls.length).toBe(1);
  });
});
