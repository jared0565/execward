import { describe, expect, it } from "vitest";
import { COMPATIBILITY_DATE } from "../src/worker/bindings";
import { deployedProblems, exposureProblems, type DeployedVersion } from "../src/worker/deployed-check";

describe("who can reach the deployed Worker (model-review finding 1a8dc5ed3d70)", () => {
  const SIGN_IN = "https://team.cloudflareaccess.com/cdn-cgi/access/login/console.execward.com?kid=x";
  const guarded = [
    { host: "console.execward.com", status: 302, location: SIGN_IN },
    { host: "mcp.execward.com", status: 401 },
  ];

  it("accepts addresses that refuse a visitor who has not signed in, or send them to Access's sign-in page", () => {
    expect(exposureProblems(guarded)).toEqual([]);
    expect(exposureProblems([{ host: "console.execward.com", status: 403 }, guarded[1]!])).toEqual([]);
  });

  it("reports an address that answers such a visitor", () => {
    expect(exposureProblems([{ host: "console.execward.com", status: 200 }, guarded[1]!])).toEqual(["the address console.execward.com answered a visitor who has not signed in with status 200, not a refusal"]);
    expect(exposureProblems([guarded[0]!, { host: "mcp.execward.com", status: 404 }])).toHaveLength(1);
  });

  it.each([
    ["no address", undefined],
    ["another site", "https://elsewhere.example/login"],
    ["a site whose name only contains Access's", "https://cloudflareaccess.com.evil.example/login"],
    ["something that is not an address", "/console"],
  ])("reports a redirect to %s", (_name, location) => {
    const probe = { host: "console.execward.com", status: 302, ...(location === undefined ? {} : { location }) };
    expect(exposureProblems([probe, guarded[1]!])).toEqual(["the address console.execward.com sends a visitor who has not signed in somewhere other than Cloudflare Access's sign-in page"]);
  });

  it("reports an address that was not checked or could not be reached, since nothing is known about it", () => {
    expect(exposureProblems([guarded[0]!])).toEqual(["the address mcp.execward.com was not checked"]);
    expect(exposureProblems([guarded[0]!, { host: "mcp.execward.com", status: undefined }])).toEqual(["the address mcp.execward.com could not be reached, so it is not known whether it is guarded"]);
  });
});

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
