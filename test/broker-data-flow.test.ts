import { describe, expect, it } from "vitest";
import { brokerHost } from "../src/broker/broker";
import { memoryPolicyStore } from "../src/broker/policy-store";
import type { PolicyRecord } from "../src/contracts/policy";
import { CALL_LIMITS } from "../src/limits";
import { record } from "./fixtures/policy";

const URL_SCHEMA = {
  type: "object",
  properties: { q: { type: "string" }, to: { type: "string", format: "uri" }, body: { type: "string" } },
};

function setup(outbound: Partial<PolicyRecord> = {}) {
  const upstreamCalls: string[] = [];
  const host = brokerHost({
    store: memoryPolicyStore([
      record("list_issues"),
      record("get_file", { dataClass: "confidential", sensitive: true }),
      record("web_search", { dataClass: "public", outbound: true, ...outbound }),
    ]),
    upstream: async ({ record: called }) => {
      upstreamCalls.push(called.tool);
      return { text: "CANARY-contents" };
    },
    definitionFor: async () => ({ description: "test tool", inputSchema: URL_SCHEMA }),
  });
  return { host, upstreamCalls };
}

const BIG = "x".repeat(CALL_LIMITS.largeArgumentBytes + 1);

describe("the data-flow rule (FR-29)", () => {
  it("lets an outbound tool be called when nothing sensitive has been read", async () => {
    const { host, upstreamCalls } = setup();
    await host.callTool("github_list_issues", {});
    await host.callTool("github_web_search", { q: "weather" });
    expect(upstreamCalls).toEqual(["list_issues", "web_search"]);
    expect(host.securityError()).toBeUndefined();
  });

  it("refuses an outbound call after a sensitive read, and ends the run", async () => {
    const { host, upstreamCalls } = setup();
    await host.callTool("github_get_file", {});
    await expect(host.callTool("github_web_search", { q: "CANARY-contents" })).rejects.toThrow(
      'policy_denied: the run has read sensitive data from "github_get_file", and this tool can send data out',
    );
    expect(upstreamCalls).toEqual(["get_file"]);
    expect(host.securityError()?.code).toBe("policy_denied");
    expect(JSON.stringify(host.denials)).not.toContain("CANARY");
    await expect(host.callTool("github_list_issues", {})).rejects.toThrow("policy_denied");
  });

  it("refuses it however innocent the outbound arguments look", async () => {
    const { host, upstreamCalls } = setup();
    await host.callTool("github_get_file", {});
    await expect(host.callTool("github_web_search", {})).rejects.toThrow("policy_denied");
    expect(upstreamCalls).toEqual(["get_file"]);
  });

  it("allows the order the other way round: outbound first, sensitive read after", async () => {
    const { host, upstreamCalls } = setup();
    await host.callTool("github_web_search", { q: "weather" });
    await host.callTool("github_get_file", {});
    expect(upstreamCalls).toEqual(["web_search", "get_file"]);
    // But not a second outbound call once the sensitive read has happened.
    await expect(host.callTool("github_web_search", { q: "weather" })).rejects.toThrow("policy_denied");
  });

  it("does not count a sensitive read that failed", async () => {
    const calls: string[] = [];
    const host = brokerHost({
      store: memoryPolicyStore([record("get_file", { sensitive: true }), record("web_search", { outbound: true })]),
      upstream: async ({ record: called }) => {
        calls.push(called.tool);
        if (called.tool === "get_file") throw new Error("Not Found");
        return "ok";
      },
      definitionFor: async () => ({ description: "test tool", inputSchema: URL_SCHEMA }),
    });
    await host.callTool("github_get_file", {}).catch(() => undefined);
    await expect(host.callTool("github_web_search", { q: "x" })).resolves.toBe("ok");
  });

  describe("with destinations the owner has listed for the tool", () => {
    const listed = { destinationAllowlist: ["hooks.example.com"] };

    it("allows a call that names a listed destination, even after a sensitive read", async () => {
      const { host, upstreamCalls } = setup(listed);
      await host.callTool("github_get_file", {});
      await host.callTool("github_web_search", { to: "https://hooks.example.com/report", body: "summary" });
      expect(upstreamCalls).toEqual(["get_file", "web_search"]);
    });

    it("still refuses a call that names no destination at all", async () => {
      const { host } = setup(listed);
      await host.callTool("github_get_file", {});
      await expect(host.callTool("github_web_search", { q: "CANARY-contents" })).rejects.toThrow("policy_denied: the run has read sensitive data");
    });

    it("still refuses a destination that is not listed", async () => {
      const { host } = setup(listed);
      await host.callTool("github_get_file", {});
      await expect(host.callTool("github_web_search", { to: "https://evil.example.org/" })).rejects.toThrow("policy_denied: the URL in \"to\" is not on the tool's allowlist");
    });
  });
});

describe("unusually large arguments (FR-29)", () => {
  it("refuses them to an outbound tool, even when nothing sensitive was read", async () => {
    const { host, upstreamCalls } = setup();
    await expect(host.callTool("github_web_search", { q: BIG })).rejects.toThrow(/^policy_denied: the arguments to an outbound tool are unusually large \(\d+ bytes\)$/);
    expect(upstreamCalls).toEqual([]);
    expect(host.securityError()?.code).toBe("policy_denied");
  });

  it("refuses them to an outbound tool with listed destinations too", async () => {
    const { host, upstreamCalls } = setup({ destinationAllowlist: ["hooks.example.com"] });
    await expect(host.callTool("github_web_search", { to: "https://hooks.example.com/x", body: BIG })).rejects.toThrow("unusually large");
    expect(upstreamCalls).toEqual([]);
  });

  it("lets them through to a tool that cannot send data out, and flags the call", async () => {
    const { host, upstreamCalls } = setup();
    await host.callTool("github_list_issues", { q: BIG });
    expect(upstreamCalls).toEqual(["list_issues"]);
    expect(host.flags).toEqual([{ path: "github_list_issues", kind: "large_argument", bytes: CALL_LIMITS.largeArgumentBytes + 1 + '{"q":""}'.length }]);
    expect(host.securityError()).toBeUndefined();
  });

  it("does not flag arguments at the limit", async () => {
    const { host } = setup();
    await host.callTool("github_list_issues", { q: "x".repeat(CALL_LIMITS.largeArgumentBytes - '{"q":""}'.length) });
    expect(host.flags).toEqual([]);
  });
});
