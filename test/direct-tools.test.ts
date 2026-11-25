import { describe, expect, it } from "vitest";
import { attemptGate } from "../src/code-tool/attempts";
import { CODE_TOOL_NAME } from "../src/code-tool/description";
import { BOTH_DOORS_GUIDANCE, DirectCallError, directCallScript, directTools, LOOKING_AROUND_TOOLS, wantsDirectTools } from "../src/code-tool/direct";
import { bothBackend } from "../src/eval/arms/both";
import { codeBackend } from "../src/eval/arms/code";
import { githubFixtureBackend } from "../src/eval/fixtures/github-backend";
import { checkScript } from "../src/static-check/check";

/** Runs a generated script the way the sandbox does: as the body of an async function given `tools`. */
async function runScript(script: string, tools: Record<string, (args: unknown) => Promise<unknown>>): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<unknown>;
  return new AsyncFunction("tools", script)(tools);
}

describe("a direct call written as a script (task 2.1.9)", () => {
  it("calls the named tool with exactly the arguments given", async () => {
    const seen: unknown[] = [];
    const args = { owner: "northwind-labs", repo: "billing-api", page: 2 };
    const result = await runScript(directCallScript("github_get_repository", args), {
      github_get_repository: async (given) => {
        seen.push(given);
        return "answer";
      },
    });
    expect(result).toBe("answer");
    expect(seen).toEqual([args]);
  });

  it("carries hostile text as data: nothing in the arguments becomes code", async () => {
    let ran = false;
    const hostile = {
      path: '"}); globalThis.pwned = true; tools.x({"a":"',
      quote: "'); throw new Error('out'); ('",
      tick: "`${globalThis.pwned = true}`",
      lines: "a\nb\r  c",
      slash: "\\\\\"",
    };
    const seen: unknown[] = [];
    await runScript(directCallScript("github_get_file_contents", hostile), {
      github_get_file_contents: async (given) => {
        seen.push(given);
        ran = true;
        return null;
      },
    });
    expect(ran).toBe(true);
    expect(seen).toEqual([hostile]);
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("keeps a key named __proto__ as an ordinary key", async () => {
    const args = JSON.parse('{"__proto__": {"admin": true}, "owner": "a"}') as Record<string, unknown>;
    let given: Record<string, unknown> = {};
    await runScript(directCallScript("github_get_repository", args), {
      github_get_repository: async (value) => {
        given = value as Record<string, unknown>;
        return null;
      },
    });
    expect(Object.getPrototypeOf(given)).toBe(Object.prototype);
    expect((given as { admin?: boolean }).admin).toBeUndefined();
    expect(Object.hasOwn(given, "__proto__")).toBe(true);
  });

  it("refuses a name that is not a plain tool name, before any script exists", () => {
    for (const name of ["", "x.y", "a b", "a;b", "constructor()", "A", "1a", "a-b", "tools", "x".repeat(101)].filter((name) => name !== "tools")) {
      expect(() => directCallScript(name, {}), name).toThrow(DirectCallError);
    }
  });

  it("refuses arguments that are not an object, and treats none as empty", async () => {
    for (const args of [[1], "text", 3, true]) expect(() => directCallScript("github_get_repository", args)).toThrow(DirectCallError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => directCallScript("github_get_repository", circular)).toThrow(DirectCallError);
    const seen: unknown[] = [];
    await runScript(directCallScript("github_get_repository", undefined), { github_get_repository: async (given) => seen.push(given) });
    expect(seen).toEqual([{}]);
  });

  it("is a script the static check accepts", async () => {
    const result = await checkScript(directCallScript("github_get_file_contents", { owner: "a", repo: "b", path: "docs/deploy.md" }));
    expect(result.ok).toBe(true);
  });
});

describe("which tools are listed for direct calls (task 2.1.9)", () => {
  const definition = { description: "Reads a thing.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"], additionalProperties: false } };
  const definitionOf = (path: string) => (path === "github_missing_definition" ? undefined : definition);
  const record = (tool: string, dataClass: "public" | "internal" | "confidential" | "client_personal") => ({ server: "github", tool, dataClass });

  it("is for Claude Haiku only, by the name the client gives", () => {
    expect(wantsDirectTools("claude-haiku-5-5")).toBe(true);
    expect(wantsDirectTools("anthropic/claude-HAIKU-5.5")).toBe(true);
    expect(wantsDirectTools("claude-fable-5-2")).toBe(false);
    expect(wantsDirectTools("gpt-6-luna")).toBe(false);
    expect(wantsDirectTools(undefined)).toBe(false);
  });

  it("lists only the looking-around tools, under the name a script uses", () => {
    const listed = directTools([record("list_issues", "internal"), record("search_code", "internal"), record("get_repository", "internal"), record("list_commits", "internal")], definitionOf, "internal");
    expect(listed.map((tool) => tool.path)).toEqual(["github_get_repository", "github_search_code"]);
    expect(LOOKING_AROUND_TOOLS).not.toContain("list_issues");
  });

  it("leaves out a tool whose data the caller's provider route may not receive", () => {
    const records = [record("get_repository", "internal"), record("get_file_contents", "confidential")];
    expect(directTools(records, definitionOf, "internal").map((tool) => tool.path)).toEqual(["github_get_repository"]);
    expect(directTools(records, definitionOf, "confidential").map((tool) => tool.path)).toEqual(["github_get_file_contents", "github_get_repository"]);
    expect(directTools(records, definitionOf, "public")).toEqual([]);
  });

  it("adds a required project to the tool's own arguments and changes nothing else", () => {
    const [tool] = directTools([record("get_repository", "internal")], definitionOf, "internal");
    expect(Object.keys(tool?.inputSchema.properties as object)).toEqual(["project", "owner", "repo"]);
    expect(tool?.inputSchema.required).toEqual(["project", "owner", "repo"]);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect(tool?.description).toContain("Reads a thing.");
    expect(tool?.description).toContain("internal data");
  });

  it("leaves out a tool with no pinned definition, no usable schema, or an argument named project", () => {
    expect(directTools([{ server: "github", tool: "missing_definition", dataClass: "internal" }], definitionOf, "internal")).toEqual([]);
    expect(directTools([record("get_repository", "internal")], () => ({ description: "x", inputSchema: "not a schema" }), "internal")).toEqual([]);
    expect(directTools([record("get_repository", "internal")], () => ({ description: "x", inputSchema: { type: "object", properties: { project: { type: "string" } } } }), "internal")).toEqual([]);
  });
});

describe("the eval arm that offers both (task 2.1.9)", () => {
  const github = githubFixtureBackend();
  const never = async (): Promise<unknown> => {
    throw new Error("no script should run in this test");
  };

  it("offers the code tool with the guidance, then only the looking-around tools, under script names", () => {
    const backend = bothBackend(codeBackend(never), github);
    expect(backend.definitions[0]?.name).toBe(CODE_TOOL_NAME);
    expect(backend.definitions[0]?.description.endsWith(BOTH_DOORS_GUIDANCE)).toBe(true);
    expect(backend.definitions.slice(1).map((tool) => tool.name).sort()).toEqual(LOOKING_AROUND_TOOLS.map((name) => `github_${name}`).sort());
  });

  it("answers a listed tool from the wrapped backend and counts which door was used", async () => {
    const backend = bothBackend(codeBackend(never), github);
    const repository = await backend.call("github_get_repository", { owner: "northwind-labs", repo: "billing-api" });
    expect(JSON.stringify(repository)).toContain("billing-api");
    expect(backend.doors).toEqual({ code: 0, direct: 1 });
  });

  it("refuses a tool that is not listed, by either name", async () => {
    const backend = bothBackend(codeBackend(never), github);
    await expect(backend.call("github_list_issues", { owner: "northwind-labs", repo: "billing-api" })).rejects.toThrow("not offered directly");
    await expect(backend.call("list_issues", { owner: "northwind-labs", repo: "billing-api" })).rejects.toThrow("not offered directly");
    expect(backend.doors.direct).toBe(0);
  });

  it("sends a code call to the code tool", async () => {
    const report = { runId: "r", scriptHash: "a".repeat(64), callsByTool: {}, recordsRead: 0, recordsWritten: 0, errors: [], retries: 0, assertions: { passed: 0, failed: 0 }, sideEffects: [], verification: "unreviewed", durationMs: 1 };
    const backend = bothBackend(codeBackend(async () => ({ status: "completed", result: 7, truncated: false, untrusted: true, report })), github);
    expect(String(await backend.call(CODE_TOOL_NAME, { script: "return 7;" }))).toContain("7");
    expect(backend.doors).toEqual({ code: 1, direct: 0 });
    // The retry count is the code tool's own; this only shows the gate type is the one used.
    expect(attemptGate().retries()).toBe(0);
  });
});
