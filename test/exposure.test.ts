import { describe, expect, it } from "vitest";
import { memoryAuditStore, verifyChain } from "../src/audit/log";
import { brokerHost } from "../src/broker/broker";
import {
  checkProjectRecord,
  CLIENT_DATA_GATE,
  exposureFor,
  memoryProjectStore,
  PROVIDER_ROUTES,
  providerCeiling,
  ProjectStoreError,
  type ProjectStore,
  type ProviderRouteId,
} from "../src/broker/exposure";
import { memoryPolicyStore } from "../src/broker/policy-store";
import { memoryQuotaStore } from "../src/broker/quotas";
import type { DataClass } from "../src/contracts/policy";
import type { Executor } from "../src/executor";
import { codeToolService, type CodeToolServiceDeps } from "../src/service";
import { record } from "./fixtures/policy";

const CLEARED = { cleared: true };
const APPROVED: ProviderRouteId[] = ["anthropic_api_commercial", "openai_api_business", "chatgpt_business_enterprise"];
const NOT_APPROVED: ProviderRouteId[] = ["claude_personal_plan", "chatgpt_personal_plan", "unknown"];

describe("which provider routes may receive which data (FR-38)", () => {
  it("covers every route, approved or not", () => {
    expect(Object.keys(PROVIDER_ROUTES).sort()).toEqual([...APPROVED, ...NOT_APPROVED].sort());
  });

  it("lets an approved route receive confidential data, and client personal data only once the gate is cleared", () => {
    for (const route of APPROVED) {
      expect(providerCeiling(route, { cleared: false }), route).toBe("confidential");
      expect(providerCeiling(route, CLEARED), route).toBe("client_personal");
    }
  });

  it("never lets a personal plan or an unknown client receive more than internal data", () => {
    for (const route of NOT_APPROVED) {
      expect(providerCeiling(route, { cleared: false }), route).toBe("internal");
      expect(providerCeiling(route, CLEARED), route).toBe("internal");
    }
  });

  it("ships with the client-data gate uncleared", () => {
    expect(CLIENT_DATA_GATE).toEqual({ cleared: false, task: "G.7" });
    expect(providerCeiling("anthropic_api_commercial")).toBe("confidential");
  });
});

describe("a project's data class (FR-32)", () => {
  it("refuses to set a project to client personal data until the gate is cleared", () => {
    expect(() => checkProjectRecord({ project: "acme", dataClass: "client_personal" })).toThrow(
      'the project "acme" cannot be set to client personal data until gate G.7 is cleared',
    );
    expect(() => memoryProjectStore([{ project: "acme", dataClass: "client_personal" }])).toThrow(ProjectStoreError);
    expect(() => checkProjectRecord({ project: "acme", dataClass: "client_personal" }, CLEARED)).not.toThrow();
    expect(() => checkProjectRecord({ project: "acme", dataClass: "confidential" })).not.toThrow();
    expect(() => checkProjectRecord({ project: "acme", dataClass: "secret" as DataClass })).toThrow(ProjectStoreError);
  });

  const projects = memoryProjectStore([
    { project: "open", dataClass: "public" },
    { project: "work", dataClass: "internal" },
    { project: "client", dataClass: "confidential" },
  ]);

  it("gives a run the lower of its project's class and its provider's ceiling", async () => {
    const cases: [string, ProviderRouteId, DataClass][] = [
      ["open", "anthropic_api_commercial", "public"],
      ["work", "anthropic_api_commercial", "internal"],
      ["client", "anthropic_api_commercial", "confidential"],
      ["client", "openai_api_business", "confidential"],
      ["client", "claude_personal_plan", "internal"],
      ["client", "chatgpt_personal_plan", "internal"],
      ["client", "unknown", "internal"],
      ["open", "unknown", "public"],
    ];
    for (const [project, route, allowed] of cases) {
      expect((await exposureFor(projects, project, route)).allowed, `${project} via ${route}`).toBe(allowed);
    }
  });

  it("treats a project with no record as public", async () => {
    expect(await exposureFor(projects, "never-heard-of-it", "anthropic_api_commercial")).toEqual({
      provider: "anthropic_api_commercial",
      projectClass: "public",
      providerCeiling: "confidential",
      allowed: "public",
    });
  });

  it("treats anything it does not recognise as the unknown route", async () => {
    for (const route of [undefined, null, 7, "", "anthropic", "ANTHROPIC_API_COMMERCIAL", "constructor", { route: "anthropic_api_commercial" }]) {
      expect(await exposureFor(projects, "client", route), JSON.stringify(route)).toMatchObject({ provider: "unknown", allowed: "internal" });
    }
  });

  it("does not let a stored client-personal record past an uncleared gate", async () => {
    // Written while the gate was (wrongly) open, or straight into the database.
    const store = memoryProjectStore([{ project: "acme", dataClass: "client_personal" }], CLEARED);
    expect(await exposureFor(store, "acme", "anthropic_api_commercial", { cleared: false })).toMatchObject({ projectClass: "confidential", allowed: "confidential" });
    expect(await exposureFor(store, "acme", "anthropic_api_commercial", CLEARED)).toMatchObject({ allowed: "client_personal" });
    expect(await exposureFor(store, "acme", "claude_personal_plan", CLEARED)).toMatchObject({ allowed: "internal" });
  });

  it("fails when the project's record cannot be read, or is not a data class", async () => {
    const down: ProjectStore = { get: async () => Promise.reject(new Error("db down")) };
    await expect(exposureFor(down, "client", "anthropic_api_commercial")).rejects.toThrow(ProjectStoreError);
    const corrupt: ProjectStore = { get: async () => ({ project: "client", dataClass: "everything" as DataClass }) };
    await expect(exposureFor(corrupt, "client", "anthropic_api_commercial")).rejects.toThrow(ProjectStoreError);
  });
});

describe("the broker keeps a run inside its data class (FR-32, FR-38)", () => {
  function broker(maxDataClass: DataClass | Promise<DataClass>) {
    const upstreamCalls: string[] = [];
    const host = brokerHost({
      store: memoryPolicyStore([
        record("get_license", { dataClass: "public" }),
        record("list_issues", { dataClass: "internal" }),
        record("get_file", { dataClass: "confidential" }),
        record("get_user", { dataClass: "client_personal" }),
      ]),
      upstream: async ({ record: called }) => (upstreamCalls.push(called.tool), "data"),
      definitionFor: async () => ({ description: "t", inputSchema: { type: "object", additionalProperties: true } }),
      maxDataClass,
    });
    return { host, upstreamCalls };
  }

  it("forwards calls to tools at or below the cap", async () => {
    const { host, upstreamCalls } = broker("internal");
    await host.callTool("github_get_license", {});
    await host.callTool("github_list_issues", {});
    expect(upstreamCalls).toEqual(["get_license", "list_issues"]);
  });

  it("refuses a tool above the cap before anything is read, and ends the run", async () => {
    const { host, upstreamCalls } = broker("internal");
    await expect(host.callTool("github_get_file", {})).rejects.toThrow("policy_denied: the tool returns confidential data, and this run may only handle internal data");
    expect(upstreamCalls).toEqual([]);
    expect(host.securityError()?.code).toBe("policy_denied");
    expect(host.dataClass()).toBeUndefined();
  });

  it("shows search and describe only the tools the run may use", async () => {
    expect(await broker("public").host.search("")).toEqual(["github_get_license"]);
    expect(await broker("confidential").host.search("")).toEqual(["github_get_file", "github_get_license", "github_list_issues"]);
    const { host } = broker("internal");
    await expect(host.describe("github_get_file")).rejects.toThrow("is available to scripts");
    await expect(host.describe("github_list_issues")).resolves.toMatchObject({ dataClass: "internal" });
    expect(host.securityError()).toBeUndefined();
  });

  it("refuses every call when the cap cannot be worked out", async () => {
    const failing = Promise.reject(new ProjectStoreError("db down"));
    failing.catch(() => undefined);
    const { host, upstreamCalls } = broker(failing);
    await expect(host.callTool("github_get_license", {})).rejects.toThrow("policy_denied: the project's data class is unavailable");
    expect(upstreamCalls).toEqual([]);
  });
});

describe("the code tool with every control in place", () => {
  /** Stands in for a script that calls the named tools and returns what it got. */
  const calling = (...tools: string[]): Executor => ({
    name: "scripted",
    async execute(request) {
      const seen: unknown[] = [];
      for (const tool of tools) seen.push(await request.host.callTool(tool, {}).catch((error: Error) => `caught ${error.message}`));
      return { status: "completed", result: seen, logs: [], truncated: false };
    },
  });

  function service(executor: Executor, overrides: Partial<CodeToolServiceDeps> = {}) {
    const audit = memoryAuditStore();
    const upstreamCalls: string[] = [];
    let run = 0;
    const serve = codeToolService({
      executor,
      policy: memoryPolicyStore([record("list_issues", { dataClass: "internal" }), record("get_file", { dataClass: "confidential", sensitive: true })]),
      projects: memoryProjectStore([
        { project: "work", dataClass: "internal" },
        { project: "client", dataClass: "confidential" },
      ]),
      quotas: memoryQuotaStore(),
      audit,
      upstream: async ({ record: called }) => (upstreamCalls.push(called.tool), { from: called.tool, text: "CANARY-client-file" }),
      definitionFor: async () => ({ description: "t", inputSchema: { type: "object", additionalProperties: true } }),
      docsFor: async () => undefined,
      now: () => 1_800_000_000_000,
      newRunId: () => `run-${++run}`,
      ...overrides,
    });
    const logged = () => audit.entries.map((entry) => ({ kind: entry.kind, ...(JSON.parse(entry.content ?? "{}") as Record<string, unknown>) }));
    return { serve, audit, upstreamCalls, logged };
  }
  const input = (project: string) => ({ script: "return 1;", project });

  it("returns confidential data to an approved route in a confidential project, and records the provider", async () => {
    const { serve, logged, audit } = service(calling("github_get_file"));
    const output = await serve(input("client"), { providerRoute: "anthropic_api_commercial" });
    expect(output).toMatchObject({ status: "completed", dataClass: "confidential", result: [{ from: "get_file" }] });
    expect(logged()[0]).toMatchObject({ kind: "run_started", provider: "anthropic_api_commercial", allowedDataClass: "confidential" });
    expect(await verifyChain(audit.entries)).toMatchObject({ ok: true });
  });

  it("refuses the same call from a personal plan, before the file is read", async () => {
    const { serve, upstreamCalls, logged } = service(calling("github_get_file"));
    const output = await serve(input("client"), { providerRoute: "claude_personal_plan" });
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied" } });
    expect(JSON.stringify(output)).not.toContain("CANARY");
    expect(upstreamCalls).toEqual([]);
    expect(logged()).toMatchObject([
      { kind: "run_started", provider: "claude_personal_plan", allowedDataClass: "internal" },
      { kind: "run_finished", security: true, calls: [{ path: "github_get_file", outcome: "policy_denied" }] },
    ]);
  });

  it("treats a caller with no established route as unknown, and records it as that", async () => {
    const { serve, upstreamCalls, logged } = service(calling("github_list_issues", "github_get_file"));
    const output = await serve(input("client"), { providerRoute: undefined });
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied" } });
    expect(upstreamCalls).toEqual(["list_issues"]);
    expect(logged()[0]).toMatchObject({ provider: "unknown", allowedDataClass: "internal" });
  });

  it("holds a project to its own class even on an approved route", async () => {
    const { serve, upstreamCalls } = service(calling("github_list_issues", "github_get_file"));
    const output = await serve(input("work"), { providerRoute: "anthropic_api_commercial" });
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied", message: expect.stringContaining("this run may only handle internal data") as string } });
    expect(upstreamCalls).toEqual(["list_issues"]);
  });

  it("gives a project with no record nothing above public", async () => {
    const { serve, upstreamCalls } = service(calling("github_list_issues"));
    const output = await serve(input("never-set-up"), { providerRoute: "anthropic_api_commercial" });
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied" } });
    expect(upstreamCalls).toEqual([]);
  });

  it("does not start a run when the project's record cannot be read", async () => {
    let executed = 0;
    const counting: Executor = { name: "scripted", execute: async () => (executed++, { status: "completed", result: 1, logs: [], truncated: false }) };
    const { serve, logged } = service(counting, { projects: { get: async () => Promise.reject(new Error("db down")) } });
    const output = await serve(input("client"), { providerRoute: "anthropic_api_commercial" });
    expect(output).toMatchObject({ status: "refused", error: { code: "policy_denied", message: "the project's data class could not be read, so the run was not started" } });
    expect(executed).toBe(0);
    expect(logged()).toMatchObject([{ kind: "run_refused", security: true }]);
    // The refused run did not keep its slot: two more runs fit under the limit of two at once.
    const working = service(counting);
    expect((await working.serve(input("work"), { providerRoute: "unknown" })).status).toBe("completed");
  });

  it("applies quotas: the eleventh run in a minute is refused", async () => {
    const { serve } = service(calling());
    for (let n = 0; n < 10; n++) expect((await serve(input("work"), { providerRoute: "unknown" })).status, `run ${n + 1}`).toBe("completed");
    expect(await serve(input("work"), { providerRoute: "unknown" })).toMatchObject({ status: "refused", error: { code: "quota_exceeded" } });
  });

  it("writes every run to the one log, in a chain that verifies", async () => {
    const { serve, audit } = service(calling("github_list_issues"));
    await serve(input("work"), { providerRoute: "unknown" });
    await serve({ script: "return fetch('x');", project: "work" }, { providerRoute: "unknown" });
    await serve(input("client"), { providerRoute: "openai_api_business" });
    expect(audit.entries.map((entry) => entry.kind)).toEqual(["run_started", "run_finished", "run_refused", "run_started", "run_finished"]);
    expect(await verifyChain(audit.entries)).toEqual({ ok: true, entries: 5 });
  });
});
