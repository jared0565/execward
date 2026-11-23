import { describe, expect, it } from "vitest";
import { pathAllowed, urlAllowed } from "../src/broker/allowlists";
import { brokerHost, type Upstream } from "../src/broker/broker";
import { checkAgainstSchema, schemaProblems } from "../src/broker/json-schema";
import { memoryPolicyStore } from "../src/broker/policy-store";
import type { PolicyRecord } from "../src/contracts/policy";
import { record } from "./fixtures/policy";

const ISSUE_SCHEMA = {
  type: "object",
  properties: {
    number: { type: "integer", minimum: 1 },
    state: { type: "string", enum: ["open", "closed"] },
    labels: { type: "array", items: { type: "string", maxLength: 20 }, maxItems: 3 },
    since: { type: "string", format: "date" },
  },
  required: ["number"],
};

const problems = (value: unknown, schema: unknown = ISSUE_SCHEMA) => checkAgainstSchema(value, schema).problems;

describe("checking arguments against a tool's input schema (FR-34)", () => {
  it("accepts arguments that match", () => {
    expect(problems({ number: 7 })).toEqual([]);
    expect(problems({ number: 7, state: "open", labels: ["bug", "p1"], since: "2026-11-01" })).toEqual([]);
  });

  it.each([
    ["a wrong type", { number: "12; DROP TABLE issues" }, "number: expected integer, got string"],
    ["a fraction where a whole number is needed", { number: 1.5 }, "number: expected integer, got number"],
    ["a missing required field", { state: "open" }, 'arguments: the field "number" is missing'],
    ["an unknown field", { number: 7, debug: true }, 'arguments: the field "debug" is not allowed'],
    ["a value outside the allowed set", { number: 7, state: "deleted" }, "state: is not one of the allowed values"],
    ["a number below the minimum", { number: 0 }, "number: is below the minimum of 1"],
    ["too many items", { number: 7, labels: ["a", "b", "c", "d"] }, "labels: has more than 3 items"],
    ["a bad item deep in a list", { number: 7, labels: ["ok", 5] }, "labels[1]: expected string, got integer"],
    ["an over-long string", { number: 7, labels: ["x".repeat(21)] }, "labels[0]: is longer than 20 characters"],
    ["a malformed date", { number: 7, since: "yesterday" }, "since: is not a date"],
    ["arguments that are not an object", "number=7", "arguments: expected object, got string"],
    ["a list in place of an object", [7], "arguments: expected object, got array"],
    ["nothing where an object is needed", null, "arguments: expected object, got null"],
  ])("refuses %s", (_label, value, expected) => {
    expect(problems(value)).toContain(expected);
  });

  it("never repeats the offending value in a problem", () => {
    const text = JSON.stringify(problems({ number: "12; DROP TABLE issues", state: "hunter2-password", debug: "leak-me" }));
    expect(text).not.toContain("DROP TABLE");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("leak-me");
  });

  it("refuses unknown fields unless the schema explicitly allows them", () => {
    expect(problems({ extra: 1 }, { type: "object" })).toEqual(['arguments: the field "extra" is not allowed']);
    expect(problems({ extra: 1 }, { type: "object", additionalProperties: false })).toEqual(['arguments: the field "extra" is not allowed']);
    expect(problems({ extra: 1 }, { type: "object", additionalProperties: true })).toEqual([]);
    expect(problems({ extra: "x" }, { type: "object", additionalProperties: { type: "integer" } })).toEqual(["extra: expected integer, got string"]);
    expect(problems({ inner: { extra: 1 } }, { type: "object", properties: { inner: { type: "object", properties: {} } } })).toEqual([
      'inner: the field "extra" is not allowed',
    ]);
  });

  it("is not fooled by fields named after built-in object properties", () => {
    expect(problems({ number: 7, constructor: 1 })).toContain('arguments: the field "constructor" is not allowed');
    expect(problems(JSON.parse('{"number":7,"__proto__":{"admin":true}}'))).toContain('arguments: the field "__proto__" is not allowed');
    expect(problems({}, { type: "object", required: ["toString"] })).toEqual(['arguments: the field "toString" is missing']);
  });

  it("supports patterns, anyOf, const and several types", () => {
    const schema = {
      type: "object",
      properties: {
        sha: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
        ref: { anyOf: [{ type: "string", maxLength: 5 }, { type: "integer" }] },
        kind: { const: "issue" },
        cursor: { type: ["string", "null"] },
      },
    };
    expect(problems({ sha: "abc1234", ref: 3, kind: "issue", cursor: null }, schema)).toEqual([]);
    expect(problems({ sha: "not-a-sha" }, schema)).toEqual(["sha: does not match the required pattern"]);
    expect(problems({ ref: "much too long" }, schema)).toEqual(["ref: matches none of the allowed shapes"]);
    expect(problems({ kind: "pull" }, schema)).toEqual(["kind: is not the one allowed value"]);
    expect(problems({ cursor: 4 }, schema)).toEqual(["cursor: expected string or null, got integer"]);
  });

  it("refuses to use a schema it cannot fully enforce", () => {
    for (const schema of [
      { type: "object", $ref: "#/definitions/x" },
      { type: "object", properties: { a: { not: { type: "string" } } } },
      { type: "object", properties: { a: { type: "string", format: "hostname" } } },
      { type: "object", patternProperties: { "^x": {} } },
      { type: "object", properties: { a: { type: "text" } } },
      { type: "object", properties: { a: { type: "string", pattern: "(" } } },
      "not a schema",
      null,
    ]) {
      expect(schemaProblems(schema).length, JSON.stringify(schema)).toBeGreaterThan(0);
      expect(problems({}, schema)[0], JSON.stringify(schema)).toContain("the tool's input schema cannot be enforced");
    }
    expect(schemaProblems(ISSUE_SCHEMA)).toEqual([]);
  });

  it("stops at a nesting limit instead of running away", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let level = 0; level < 40; level++) schema = { type: "object", properties: { next: schema } };
    expect(schemaProblems(schema).some((problem) => problem.includes("nested too deeply"))).toBe(true);
  });

  it("finds the URLs and paths a schema marks, wherever they sit", () => {
    const schema = {
      type: "object",
      properties: {
        target: { type: "string", format: "uri" },
        files: { type: "array", items: { type: "string", format: "path" } },
        either: { anyOf: [{ type: "integer" }, { type: "string", format: "uri" }] },
      },
    };
    expect(checkAgainstSchema({ target: "https://a.example/x", files: ["docs/a.md", "docs/b.md"], either: "https://b.example" }, schema).located).toEqual([
      { kind: "url", value: "https://a.example/x", at: "target" },
      { kind: "path", value: "docs/a.md", at: "files[0]" },
      { kind: "path", value: "docs/b.md", at: "files[1]" },
      { kind: "url", value: "https://b.example", at: "either" },
    ]);
  });
});

describe("the URL allowlist (FR-34)", () => {
  const LIST = ["api.github.com", "*.example.com", "internal.test:8443"];

  it.each(["https://api.github.com/repos/a/b", "https://API.GitHub.com/x?y=1", "https://docs.example.com/", "https://a.b.example.com/", "https://internal.test:8443/x"])(
    "allows %s",
    (url) => expect(urlAllowed(url, LIST)).toBe(true),
  );

  it.each([
    ["another host", "https://evil.example.org/"],
    ["plain http", "http://api.github.com/"],
    ["a look-alike suffix", "https://api.github.com.evil.org/"],
    ["a look-alike prefix", "https://notapi.github.com/"],
    ["credentials in the URL", "https://user:pass@api.github.com/"],
    ["the allowed host as the user name", "https://api.github.com@evil.org/"],
    ["another port", "https://api.github.com:8443/"],
    ["the bare domain of a wildcard", "https://example.com/"],
    ["a wildcard look-alike", "https://evilexample.com/"],
    ["a wildcard host on another port", "https://docs.example.com:8443/"],
    ["another scheme", "file:///etc/passwd"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a relative URL", "/repos/a/b"],
    ["not a URL", "api.github.com"],
    ["an address", "https://169.254.169.254/latest/meta-data/"],
  ])("refuses %s", (_label, url) => expect(urlAllowed(url, LIST)).toBe(false));

  it("allows nothing when the list is empty", () => {
    expect(urlAllowed("https://api.github.com/", [])).toBe(false);
  });
});

describe("the path allowlist (FR-34)", () => {
  const LIST = ["docs/", "README.md"];

  it.each(["docs/a.md", "docs/deep/er/file.txt", "README.md"])("allows %s", (path) => expect(pathAllowed(path, LIST)).toBe(true));

  it.each([
    ["another folder", "src/secret.ts"],
    ["climbing out", "docs/../.env"],
    ["climbing out at the end", "docs/.."],
    ["a look-alike folder", "docs-private/a.md"],
    ["the folder itself with no file", "docs/"],
    ["an absolute path", "/etc/passwd"],
    ["a drive letter", "C:/Windows/system.ini"],
    ["a home path", "~/.ssh/id_rsa"],
    ["back-slashes", "docs\\..\\.env"],
    ["an encoded dot", "docs/%2e%2e/.env"],
    ["an encoded slash", "docs%2f..%2f.env"],
    ["a null byte", "docs/a.md\u0000.png"],
    ["a doubled slash", "docs//a.md"],
    ["a dot segment", "docs/./a.md"],
    ["an empty path", ""],
    ["a file that only starts like an allowed one", "README.md.bak"],
  ])("refuses %s", (_label, path) => expect(pathAllowed(path, LIST)).toBe(false));

  it("allows nothing when the list is empty, and never the whole tree", () => {
    expect(pathAllowed("docs/a.md", [])).toBe(false);
    expect(pathAllowed("anything/at/all", ["/"])).toBe(false);
  });
});

describe("the broker checks arguments before a call goes out (FR-34)", () => {
  function setup(schema: unknown, overrides: Partial<PolicyRecord> = {}, hasDefinition = true) {
    const upstreamCalls: unknown[] = [];
    const upstream: Upstream = async ({ args }) => {
      upstreamCalls.push(args);
      return "ok";
    };
    const host = brokerHost({
      store: memoryPolicyStore([record("get_file", overrides)]),
      upstream,
      definitionFor: async () => (hasDefinition ? { description: "reads a file", inputSchema: schema } : undefined),
    });
    return { host, upstreamCalls };
  }

  const FILE_SCHEMA = {
    type: "object",
    properties: { path: { type: "string", format: "path" }, mirror: { type: "string", format: "uri" } },
    required: ["path"],
  };

  it("forwards a call whose arguments match and are on the allowlists", async () => {
    const { host, upstreamCalls } = setup(FILE_SCHEMA, { pathAllowlist: ["docs/"], destinationAllowlist: ["api.github.com"] });
    expect(await host.callTool("github_get_file", { path: "docs/a.md", mirror: "https://api.github.com/x" })).toBe("ok");
    expect(upstreamCalls).toEqual([{ path: "docs/a.md", mirror: "https://api.github.com/x" }]);
  });

  it("rejects a schema violation as schema_invalid, which the script may fix and retry", async () => {
    const { host, upstreamCalls } = setup(FILE_SCHEMA, { pathAllowlist: ["docs/"] });
    await expect(host.callTool("github_get_file", { path: 7, debug: true })).rejects.toThrow("schema_invalid: path: expected string, got integer");
    await expect(host.callTool("github_get_file", undefined)).rejects.toThrow('schema_invalid: arguments: the field "path" is missing');
    expect(upstreamCalls).toEqual([]);
    // Not a security refusal: the run goes on.
    expect(host.securityError()).toBeUndefined();
    expect(await host.callTool("github_get_file", { path: "docs/a.md" })).toBe("ok");
  });

  it.each([
    ["a path off the allowlist", { path: "src/secret.ts" }, 'the path in "path" is not on the tool\'s allowlist'],
    ["a path that climbs out", { path: "docs/../.env" }, 'the path in "path" is not on the tool\'s allowlist'],
    ["a URL off the allowlist", { path: "docs/a.md", mirror: "https://evil.example.org/c?d=secret-value" }, 'the URL in "mirror" is not on the tool\'s allowlist'],
  ])("refuses %s with policy_denied and ends the run", async (_label, args, reason) => {
    const { host, upstreamCalls } = setup(FILE_SCHEMA, { pathAllowlist: ["docs/"], destinationAllowlist: ["api.github.com"] });
    await expect(host.callTool("github_get_file", args)).rejects.toThrow(`policy_denied: ${reason}`);
    expect(upstreamCalls).toEqual([]);
    expect(host.securityError()).toEqual({ code: "policy_denied", message: `the call to "github_get_file" was refused: ${reason}` });
    expect(JSON.stringify(host.denials)).not.toContain("secret");
    await expect(host.callTool("github_get_file", { path: "docs/a.md" })).rejects.toThrow("policy_denied");
  });

  it("allows no URL and no path when a record lists none", async () => {
    const { host, upstreamCalls } = setup(FILE_SCHEMA);
    await expect(host.callTool("github_get_file", { path: "README.md" })).rejects.toThrow("policy_denied");
    expect(upstreamCalls).toEqual([]);
  });

  it("refuses every call to a tool with no definition, or a schema it cannot enforce", async () => {
    const none = setup(FILE_SCHEMA, {}, false);
    await expect(none.host.callTool("github_get_file", { path: "docs/a.md" })).rejects.toThrow("policy_denied: the tool has no definition");
    expect(none.upstreamCalls).toEqual([]);

    const unusable = setup({ type: "object", $ref: "#/x" });
    await expect(unusable.host.callTool("github_get_file", {})).rejects.toThrow("schema_invalid: the tool's input schema cannot be enforced");
    expect(unusable.upstreamCalls).toEqual([]);
  });
});
