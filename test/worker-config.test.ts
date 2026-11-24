import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "../src/contracts/version";
import { handleRequest } from "../src/worker";
import { ALLOWED_BINDINGS, COMPATIBILITY_DATE } from "../src/worker/bindings";
import { parseWorkerConfig, stripJsonComments, workerConfigProblems } from "../src/worker/config-check";

const TODAY = new Date("2026-11-22T00:00:00Z");

function good(): Record<string, unknown> {
  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name: "execward",
    main: "src/worker.ts",
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: [],
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    upload_source_maps: true,
    observability: { enabled: true },
    worker_loaders: [{ binding: "LOADER" }],
    d1_databases: [{ binding: "DB", database_name: "execward", database_id: "33b54ace-0649-4949-abe5-dacd833dfe10", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "BACKUPS", bucket_name: "execward-backups" }],
    routes: [{ pattern: "console.execward.com", custom_domain: true }],
    triggers: { crons: ["*/5 * * * *"] },
  };
}

describe("stripJsonComments", () => {
  it("removes line and block comments", () => {
    expect(JSON.parse(stripJsonComments('// top\n{ "a": 1, /* mid */ "b": 2 } // end'))).toEqual({ a: 1, b: 2 });
  });

  it("leaves comment-like text inside strings alone", () => {
    const parsed = JSON.parse(stripJsonComments('{ "url": "https://example.com/a", "note": "/* keep */ \\" // keep" }'));
    expect(parsed).toEqual({ url: "https://example.com/a", note: '/* keep */ " // keep' });
  });
});

describe("workerConfigProblems", () => {
  it("accepts the allowed configuration", () => {
    expect(workerConfigProblems(good(), TODAY)).toEqual([]);
  });

  it.each([
    ["a KV namespace", { kv_namespaces: [{ binding: "CACHE", id: "abc" }] }],
    ["a queue", { queues: { producers: [{ binding: "Q", queue: "x" }] } }],
    ["a secrets store", { secrets_store_secrets: [{ binding: "S", store_id: "x", secret_name: "y" }] }],
    ["a service binding", { services: [{ binding: "OTHER", service: "other-worker" }] }],
    ["a Durable Object", { durable_objects: { bindings: [{ name: "DO", class_name: "X" }] } }],
    ["an environment value", { vars: { API_BASE: "https://example.com" } }],
    ["a named environment", { env: { staging: { kv_namespaces: [{ binding: "CACHE", id: "abc" }] } } }],
    ["a binding type that does not exist yet", { future_bindings: [{ binding: "X" }] }],
  ])("refuses %s", (_label, extra) => {
    const problems = workerConfigProblems({ ...good(), ...extra }, TODAY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is not on the allowlist");
  });

  it.each([
    ["another address", [{ pattern: "example.com/*", zone_name: "example.com" }]],
    ["a second address beside the console's", [{ pattern: "console.execward.com", custom_domain: true }, { pattern: "api.execward.com", custom_domain: true }]],
    ["the whole domain", [{ pattern: "execward.com/*", zone_name: "execward.com" }]],
    ["a wildcard", [{ pattern: "*.execward.com/*", zone_name: "execward.com" }]],
    ["the console's address as a plain route", ["console.execward.com/*"]],
    ["no address", []],
    ["a missing list", undefined],
  ])("refuses %s: the console's address behind Access is the only way in", (_label, routes) => {
    const problems = workerConfigProblems({ ...good(), routes }, TODAY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"routes" must be exactly');
  });

  it("refuses a workers.dev address, which Access on the console's hostname would not guard", () => {
    expect(workerConfigProblems({ ...good(), workers_dev: true }, TODAY)).toEqual(['"workers_dev" must be false, found true']);
    expect(workerConfigProblems({ ...good(), preview_urls: true }, TODAY)).toEqual(['"preview_urls" must be false, found true']);
  });

  it("refuses a second database or bucket, under any name", () => {
    const database = { ...good(), d1_databases: [...(good().d1_databases as unknown[]), { binding: "OTHER", database_name: "x", database_id: "y" }] };
    expect(workerConfigProblems(database, TODAY)).toEqual([
      'binding "OTHER" in "d1_databases" is not on the allowlist',
      'binding "OTHER" in "d1_databases" has settings that are not on the allowlist: database_name, database_id',
    ]);
    const bucket = { ...good(), r2_buckets: [...(good().r2_buckets as unknown[]), { binding: "ASSETS", bucket_name: "pivot-parlor-assets" }] };
    expect(workerConfigProblems(bucket, TODAY)[0]).toBe('binding "ASSETS" in "r2_buckets" is not on the allowlist');
  });

  it("refuses the allowed binding name pointed at another database or bucket", () => {
    const database = { ...good(), d1_databases: [{ binding: "DB", database_name: "execward", database_id: "e0ec5608-b235-4059-816a-230d1be84317", migrations_dir: "migrations" }] };
    expect(workerConfigProblems(database, TODAY)).toEqual(['binding "DB" in "d1_databases" must have "database_id" set to "33b54ace-0649-4949-abe5-dacd833dfe10"']);
    const bucket = { ...good(), r2_buckets: [{ binding: "BACKUPS", bucket_name: "pivot-parlor-audit" }] };
    expect(workerConfigProblems(bucket, TODAY)).toEqual(['binding "BACKUPS" in "r2_buckets" must have "bucket_name" set to "execward-backups"']);
    const remote = { ...good(), r2_buckets: [{ binding: "BACKUPS", bucket_name: "execward-backups", jurisdiction: "eu" }] };
    expect(workerConfigProblems(remote, TODAY)[0]).toContain("settings that are not on the allowlist: jurisdiction");
  });

  it("refuses any timer but the one allowed, and requires that one", () => {
    expect(workerConfigProblems({ ...good(), triggers: { crons: ["* * * * *"] } }, TODAY)).toEqual(['"triggers" must be exactly {"crons":["*/5 * * * *"]}']);
    expect(workerConfigProblems({ ...good(), triggers: { crons: ["*/5 * * * *", "0 0 * * *"] } }, TODAY).length).toBe(1);
    const { triggers: _gone, ...none } = good();
    void _gone;
    expect(workerConfigProblems(none, TODAY).length).toBe(1);
  });

  it("refuses a second Worker Loader under another name", () => {
    const config = { ...good(), worker_loaders: [{ binding: "LOADER" }, { binding: "SECOND" }] };
    expect(workerConfigProblems(config, TODAY)).toEqual(['binding "SECOND" in "worker_loaders" is not on the allowlist']);
  });

  it("refuses extra settings on an allowed binding", () => {
    const config = { ...good(), worker_loaders: [{ binding: "LOADER", remote: true }] };
    expect(workerConfigProblems(config, TODAY)[0]).toContain("settings that are not on the allowlist: remote");
  });

  it("requires the allowed binding to be present", () => {
    const config = { ...good(), worker_loaders: [] };
    expect(workerConfigProblems(config, TODAY)).toEqual(['binding "LOADER" must be declared once in "worker_loaders", found 0']);
  });

  it("refuses a public address", () => {
    expect(workerConfigProblems({ ...good(), workers_dev: true }, TODAY)[0]).toContain('"workers_dev" must be false');
    expect(workerConfigProblems({ ...good(), preview_urls: true }, TODAY)[0]).toContain('"preview_urls" must be false');
  });

  it("refuses a compatibility date that is missing, differs from the code, or is in the future", () => {
    const { compatibility_date: _removed, ...missing } = good();
    void _removed;
    expect(workerConfigProblems(missing, TODAY)[0]).toContain("must be a pinned date");
    expect(workerConfigProblems({ ...good(), compatibility_date: "2026-01-01" }, TODAY)[0]).toContain("but the code pins");
    expect(workerConfigProblems(good(), new Date("2026-01-01T00:00:00Z"))[0]).toContain("is in the future");
  });

  it("refuses a compatibility flag that is not on the allowlist", () => {
    const config = { ...good(), compatibility_flags: ["nodejs_compat"] };
    expect(workerConfigProblems(config, TODAY)).toEqual(['compatibility flag "nodejs_compat" is not on the allowlist']);
  });
});

describe("this repository's Worker (task 1.1.1)", () => {
  const config = parseWorkerConfig(readFileSync("wrangler.jsonc", "utf8"));

  it("has a configuration that passes the allowlist", () => {
    expect(workerConfigProblems(config)).toEqual([]);
  });

  it("has exactly three bindings: the Worker Loader, its own database and the backup bucket", () => {
    expect(ALLOWED_BINDINGS.map((entry) => `${entry.section}:${entry.binding}`)).toEqual(["worker_loaders:LOADER", "d1_databases:DB", "r2_buckets:BACKUPS"]);
  });

  it("builds the Worker in CI, so a broken configuration cannot merge", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("npm run build:worker");
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["build:worker"]).toContain("wrangler deploy --dry-run");
  });

  it("answers the health check and nothing else", async () => {
    const health = handleRequest(new Request("https://execward.invalid/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ name: "execward", contracts: CONTRACT_VERSION });
    expect(handleRequest(new Request("https://execward.invalid/")).status).toBe(404);
    expect(handleRequest(new Request("https://execward.invalid/health", { method: "POST" })).status).toBe(404);
  });
});
