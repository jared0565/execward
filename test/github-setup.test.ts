import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore, verifyChain } from "../src/audit/log";
import type { ProjectRecord } from "../src/broker/exposure";
import { GITHUB_TOOL_DEFINITIONS, githubPinsAndPolicy } from "../src/connectors/github";
import type { PolicyRecord } from "../src/contracts/policy";
import { policyRecordSchema } from "../src/contracts/policy";
import { addProject, SETUP_ACTOR, setupGithub } from "../src/setup/github-setup";

const NOW = Date.UTC(2026, 10, 24, 12);

function setup(over: { failAudit?: boolean } = {}) {
  const policy: PolicyRecord[] = [];
  const projects: ProjectRecord[] = [];
  const store = memoryAuditStore();
  const audit = over.failAudit
    ? {
        record: async () => {
          throw new Error("the log is down");
        },
      }
    : auditLog(store, () => NOW);
  return { policy, projects, store, deps: { putPolicy: async (record: PolicyRecord) => void policy.push(record), putProject: async (record: ProjectRecord) => void projects.push(record), audit } };
}

describe("adding a project while setting a repository up (task 2.1.11)", () => {
  it("writes the project's record and an audit entry, and no tool's policy record", async () => {
    const { policy, projects, store, deps } = setup();
    expect(await addProject(deps, { project: "my-site", dataClass: "internal" })).toEqual({ project: "my-site", dataClass: "internal" });
    expect(projects).toEqual([{ project: "my-site", dataClass: "internal" }]);
    // A policy the owner changed by hand is not put back by setting a repository up.
    expect(policy).toEqual([]);
    expect(JSON.parse(store.entries.at(-1)?.content ?? "{}")).toMatchObject({ action: "add_project", by: SETUP_ACTOR, project: { project: "my-site", dataClass: "internal" } });
  });

  it("changes nothing when the audit log cannot be written, or the name or class is not allowed", async () => {
    const down = setup({ failAudit: true });
    await expect(addProject(down.deps, { project: "my-site", dataClass: "internal" })).rejects.toThrow();
    expect(down.projects).toEqual([]);
    const { projects, deps } = setup();
    await expect(addProject(deps, { project: "My Site", dataClass: "internal" })).rejects.toThrow("the project name must be");
    await expect(addProject(deps, { project: "my-site", dataClass: "client_personal" })).rejects.toThrow();
    expect(projects).toEqual([]);
  });
});

describe("connecting the GitHub tools to a deployment (task 2.1.10)", () => {
  it("writes every pinned GitHub tool, each read-only and matching the contract, and the one project", async () => {
    const { policy, projects, deps } = setup();
    const result = await setupGithub(deps, { project: "execward", dataClass: "internal" });
    expect(policy).toHaveLength(GITHUB_TOOL_DEFINITIONS.length);
    expect(policy).toEqual((await githubPinsAndPolicy()).records);
    for (const record of policy) {
      expect(policyRecordSchema.safeParse(record).success).toBe(true);
      expect(record.tier).toBe(0);
      expect(record.outbound).toBe(false);
      expect(record.server).toBe("github");
    }
    expect(projects).toEqual([{ project: "execward", dataClass: "internal" }]);
    expect(result.tools).toHaveLength(policy.length);
  });

  it("records what it did in the audit log, on the chain, naming the tools and their definition hashes", async () => {
    const { store, deps, policy } = setup();
    await setupGithub(deps, { project: "execward", dataClass: "internal" });
    expect(store.entries).toHaveLength(1);
    const entry = store.entries[0];
    expect(entry?.kind).toBe("console_change");
    expect(entry?.project).toBe("execward");
    const body = JSON.parse(entry?.content ?? "{}") as { action: string; by: string; tools: string[]; definitionHashes: Record<string, string>; project: ProjectRecord };
    expect(body).toMatchObject({ action: "github_setup", by: SETUP_ACTOR, project: { project: "execward", dataClass: "internal" } });
    expect(body.tools).toContain("github.get_repository");
    for (const record of policy) expect(body.definitionHashes[record.tool]).toBe(record.definitionHash);
    expect(await verifyChain(store.entries)).toEqual({ ok: true, entries: 1 });
  });

  it("changes nothing when the audit entry cannot be written", async () => {
    const { policy, projects, deps } = setup({ failAudit: true });
    await expect(setupGithub(deps, { project: "execward", dataClass: "internal" })).rejects.toThrow();
    expect(policy).toEqual([]);
    expect(projects).toEqual([]);
  });

  it.each(["", "Has Capitals", "../etc", "a b", "x".repeat(64)])("refuses the project name %j before writing anything", async (name) => {
    const { policy, projects, store, deps } = setup();
    await expect(setupGithub(deps, { project: name, dataClass: "internal" })).rejects.toThrow();
    expect([policy, projects, store.entries]).toEqual([[], [], []]);
  });

  it("refuses client personal data while its gate is not cleared, before writing anything", async () => {
    const { policy, projects, store, deps } = setup();
    await expect(setupGithub(deps, { project: "execward", dataClass: "client_personal" })).rejects.toThrow();
    expect([policy, projects, store.entries]).toEqual([[], [], []]);
  });
});
