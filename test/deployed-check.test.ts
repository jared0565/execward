import { describe, expect, it } from "vitest";
import { COMPATIBILITY_DATE } from "../src/worker/bindings";
import { deployedProblems, type DeployedVersion } from "../src/worker/deployed-check";

/** What Cloudflare reported for the live Worker on 2026-11-23. */
function live(): DeployedVersion {
  return {
    bindings: [
      { type: "r2_bucket", name: "BACKUPS", bucket_name: "execward-backups" },
      { type: "d1", name: "DB", id: "33b54ace-0649-4949-abe5-dacd833dfe10", database_id: "33b54ace-0649-4949-abe5-dacd833dfe10" },
      { type: "worker_loader", name: "LOADER" },
      { type: "send_email", name: "EMAIL" },
    ],
    compatibilityDate: COMPATIBILITY_DATE,
    secrets: [],
  };
}

describe("the deployed Worker against the allowlist (task 1.1.6, FR-24)", () => {
  it("accepts the Worker as deployed", () => {
    expect(deployedProblems(live())).toEqual([]);
  });

  it.each([
    ["a KV namespace added in the dashboard", { type: "kv_namespace", name: "CACHE", namespace_id: "abc" }],
    ["an environment value", { type: "plain_text", name: "API_BASE", text: "https://example.com" }],
    ["a secret bound as a value", { type: "secret_text", name: "GITHUB_TOKEN" }],
    ["a second database", { type: "d1", name: "OTHER", database_id: "e0ec5608-b235-4059-816a-230d1be84317" }],
    ["another Worker", { type: "service", name: "PEER", service: "pivot-parlor" }],
  ])("reports %s", (_label, extra) => {
    const version = { ...live(), bindings: [...live().bindings, extra] };
    expect(deployedProblems(version)).toEqual([`the deployed Worker has a binding "${extra.name}" (${extra.type}) that is not on the allowlist`]);
  });

  it("reports an allowed name pointed at another database or bucket, or of another kind", () => {
    const database = { ...live(), bindings: live().bindings.map((binding) => (binding.name === "DB" ? { ...binding, database_id: "e0ec5608-b235-4059-816a-230d1be84317" } : binding)) };
    expect(deployedProblems(database)).toEqual(['the binding "DB" points at something other than the allowlist names']);
    const bucket = { ...live(), bindings: live().bindings.map((binding) => (binding.name === "BACKUPS" ? { ...binding, bucket_name: "pivot-parlor-audit" } : binding)) };
    expect(deployedProblems(bucket)).toEqual(['the binding "BACKUPS" points at something other than the allowlist names']);
    const kind = { ...live(), bindings: live().bindings.map((binding) => (binding.name === "LOADER" ? { type: "service", name: "LOADER", service: "x" } : binding)) };
    expect(deployedProblems(kind)).toEqual(['the binding "LOADER" is a service, not a worker_loader']);
  });

  it("reports a missing binding, a secret and a changed compatibility date", () => {
    expect(deployedProblems({ ...live(), bindings: live().bindings.filter((binding) => binding.name !== "LOADER") })).toEqual(['the binding "LOADER" should be deployed once, found 0']);
    expect(deployedProblems({ ...live(), secrets: ["GITHUB_TOKEN"] })).toEqual(['the deployed Worker holds a secret named "GITHUB_TOKEN" that is not on the allowlist']);
    expect(deployedProblems({ ...live(), compatibilityDate: "2027-01-01" })).toEqual([`the deployed compatibility date is "2027-01-01", not ${COMPATIBILITY_DATE}`]);
  });
});
