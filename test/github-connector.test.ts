import { describe, expect, it } from "vitest";
import { fakeToken } from "../src/adversarial/fixtures";
import { schemaProblems, checkAgainstSchema } from "../src/broker/json-schema";
import { GITHUB_API, GITHUB_METADATA_ONLY_TOOLS, GITHUB_TOOL_DEFINITIONS, githubPinsAndPolicy, githubRequestUrl, githubUpstream, MAX_GITHUB_REPLY_BYTES } from "../src/connectors/github";
import { policyRecordSchema, type PolicyRecord } from "../src/contracts/policy";
import { GITHUB_READ_ONLY_TOOLS } from "../src/tools/github-inventory";

const TOKEN = fakeToken();

interface Sent {
  readonly url: string;
  readonly init: { method: string; headers: Record<string, string>; redirect: string };
}

function connector(reply: (url: string) => Response | Promise<Response> = () => Response.json({ ok: true }), token: () => string | undefined = () => TOKEN) {
  const sent: Sent[] = [];
  const upstream = githubUpstream({
    token,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return reply(url);
    },
  });
  return { sent, upstream };
}

// Built once: approving fifteen definitions for every lookup made one test slow enough to time out.
const approved = githubPinsAndPolicy();

async function recordFor(tool: string): Promise<PolicyRecord> {
  const { records } = await approved;
  const record = records.find((item) => item.tool === tool);
  if (!record) throw new Error(`no record for ${tool}`);
  return record;
}

describe("the GitHub connector's tools (task 1.5.1)", () => {
  it("defines exactly the tools in the inventory", () => {
    expect(GITHUB_TOOL_DEFINITIONS.map((definition) => definition.tool).sort()).toEqual(GITHUB_READ_ONLY_TOOLS.map((tool) => tool.tool).sort());
    expect(GITHUB_TOOL_DEFINITIONS.length).toBe(15);
  });

  it("gives every tool an argument schema the broker can check", () => {
    for (const definition of GITHUB_TOOL_DEFINITIONS) expect(schemaProblems(definition.inputSchema), definition.tool).toEqual([]);
  });

  it("approves every definition and builds a valid policy record that carries its hash", async () => {
    const { pins, records } = await githubPinsAndPolicy();
    expect(pins.length).toBe(15);
    for (const record of records) {
      expect(policyRecordSchema.safeParse(record).success, record.tool).toBe(true);
      expect(record.definitionHash).toBe(pins.find((pin) => pin.definition.tool === record.tool)?.hash);
      // Read-only: nothing is outbound and nothing is above tier 0.
      expect(record).toMatchObject({ server: "github", outbound: false, tier: 0 });
    }
  });

  it("refuses arguments that are missing, of the wrong kind, out of range or not listed", () => {
    const schema = GITHUB_TOOL_DEFINITIONS.find((definition) => definition.tool === "list_issues")?.inputSchema;
    const ok = (args: unknown): boolean => checkAgainstSchema(args, schema).problems.length === 0;
    expect(ok({ owner: "octo", repo: "demo", state: "closed", per_page: 50 })).toBe(true);
    expect(ok({ repo: "demo" })).toBe(false);
    expect(ok({ owner: "octo/evil", repo: "demo" })).toBe(false);
    expect(ok({ owner: "octo", repo: "demo", state: "deleted" })).toBe(false);
    expect(ok({ owner: "octo", repo: "demo", per_page: 5000 })).toBe(false);
    expect(ok({ owner: "octo", repo: "demo", method: "DELETE" })).toBe(false);
  });
});

describe("the address a call reaches", () => {
  it("builds the GitHub address from the arguments", () => {
    expect(githubRequestUrl("get_repository", { owner: "octo", repo: "demo" })).toBe(`${GITHUB_API}/repos/octo/demo`);
    expect(githubRequestUrl("list_issues", { owner: "octo", repo: "demo", state: "all", per_page: 5 })).toBe(`${GITHUB_API}/repos/octo/demo/issues?state=all&per_page=5`);
    expect(githubRequestUrl("get_file_contents", { owner: "octo", repo: "demo", path: "/src/a b/index.ts", ref: "main" })).toBe(`${GITHUB_API}/repos/octo/demo/contents/src/a%20b/index.ts?ref=main`);
    expect(githubRequestUrl("search_code", { q: "repo:octo/demo fetch & more" })).toBe(`${GITHUB_API}/search/code?q=repo%3Aocto%2Fdemo+fetch+%26+more`);
    expect(githubRequestUrl("get_issue", { owner: "octo", repo: "demo", issue_number: 7 })).toBe(`${GITHUB_API}/repos/octo/demo/issues/7`);
  });

  it("never leaves api.github.com, whatever the arguments", () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["get_repository", { owner: "..", repo: "demo" }],
      ["get_repository", { owner: "octo", repo: "demo/../../user" }],
      ["get_repository", { owner: "octo", repo: "demo?x=1" }],
      ["get_repository", { owner: "octo", repo: "demo#frag" }],
      ["get_repository", { owner: "octo", repo: "%2e%2e" }],
      ["get_repository", { owner: "evil.example.com\\@octo", repo: "demo" }],
      ["get_file_contents", { owner: "octo", repo: "demo", path: "../../../user/emails" }],
      ["get_file_contents", { owner: "octo", repo: "demo", path: "a/./../b" }],
      ["get_commit", { owner: "octo", repo: "demo", ref: ".." }],
      ["get_issue", { owner: "octo", repo: "demo", issue_number: "7/comments" }],
      ["get_issue", { owner: "octo", repo: "demo", issue_number: 1.5 }],
      ["get_repository", { owner: "octo" }],
      ["delete_repository", { owner: "octo", repo: "demo" }],
    ];
    for (const [tool, args] of attempts) expect(() => githubRequestUrl(tool, args), JSON.stringify(args)).toThrow();
    // A slash in one name is encoded, so it cannot become a second path part.
    expect(githubRequestUrl("get_commit", { owner: "octo", repo: "demo", ref: "feature/x" })).toBe(`${GITHUB_API}/repos/octo/demo/commits/feature%2Fx`);
  });
});

describe("what the connector sends and returns", () => {
  it("sends one GET to GitHub with the credential in a header, and follows no redirect", async () => {
    const { sent, upstream } = connector(() => Response.json({ full_name: "octo/demo" }));
    expect(await upstream({ record: await recordFor("get_repository"), args: { owner: "octo", repo: "demo" } })).toEqual({ full_name: "octo/demo" });
    expect(sent.length).toBe(1);
    expect(sent[0]?.url).toBe(`${GITHUB_API}/repos/octo/demo`);
    expect(sent[0]?.init).toMatchObject({ method: "GET", redirect: "manual", headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "execward" } });
    expect(sent[0]?.url).not.toContain(TOKEN);
  });

  it("uses GET for every tool", async () => {
    // A list for the tools that list, an object for the rest: a reply of the wrong kind is refused.
    const { sent, upstream } = connector((url) => Response.json(/\/(branches|commits|issues|pulls|releases)(\?|$)/.test(url) ? [] : {}));
    const args: Record<string, unknown> = { owner: "octo", repo: "demo", ref: "main", path: "README.md", q: "x", issue_number: 1, pull_number: 1 };
    for (const definition of GITHUB_TOOL_DEFINITIONS) {
      const wanted = Object.keys((definition.inputSchema as { properties: Record<string, unknown> }).properties);
      await upstream({ record: await recordFor(definition.tool), args: Object.fromEntries(Object.entries(args).filter(([name]) => wanted.includes(name) && (name !== "ref" || definition.tool !== "get_file_contents"))) });
    }
    expect(sent.length).toBe(15);
    expect(new Set(sent.map((request) => request.init.method))).toEqual(new Set(["GET"]));
    expect(sent.every((request) => request.url.startsWith(`${GITHUB_API}/`))).toBe(true);
  });

  it("reads the credential when a request is sent, and sends nothing without one", async () => {
    const store: { token?: string } = {};
    const { sent, upstream } = connector(undefined, () => store.token);
    const record = await recordFor("get_repository");
    await expect(upstream({ record, args: { owner: "octo", repo: "demo" } })).rejects.toThrow("the GitHub connector has no credential");
    expect(sent).toEqual([]);
    store.token = TOKEN;
    await upstream({ record, args: { owner: "octo", repo: "demo" } });
    expect(sent.length).toBe(1);
  });

  it("never lets the credential into a result or an error", async () => {
    const record = await recordFor("get_repository");
    const args = { owner: "octo", repo: "demo" };
    const echoing = connector(() => Response.json({ message: `Bad credentials: ${TOKEN}` }, { status: 401 }));
    const refused = await echoing.upstream({ record, args }).catch((error: Error) => error.message);
    expect(refused).toBe("GitHub answered 401: Bad credentials: [removed]");

    const failing = githubUpstream({ token: () => TOKEN, fetch: async () => Promise.reject(new Error(`connect failed, headers: Bearer ${TOKEN}`)) });
    const unreachable = await failing({ record, args }).catch((error: Error) => `${error.message} ${String(error.cause ?? "")}`);
    expect(unreachable).not.toContain(TOKEN);
    expect(unreachable).toContain("GitHub could not be reached");
  });

  it("does not follow a redirect", async () => {
    const { sent, upstream } = connector(() => new Response(null, { status: 301, headers: { location: "https://evil.example.com/" } }));
    await expect(upstream({ record: await recordFor("get_repository"), args: { owner: "octo", repo: "demo" } })).rejects.toThrow("a redirect, which is not followed");
    expect(sent.length).toBe(1);
  });

  it("reports GitHub's own errors as errors a script can catch, cut short", async () => {
    const record = await recordFor("get_issue");
    const args = { owner: "octo", repo: "demo", issue_number: 1 };
    const missing = connector(() => Response.json({ message: "Not Found" }, { status: 404 }));
    await expect(missing.upstream({ record, args })).rejects.toMatchObject({ name: "UpstreamToolError", message: "GitHub answered 404: Not Found" });
    const limited = connector(() => Response.json({ message: "x".repeat(900) }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const said = String(await limited.upstream({ record, args }).catch((error: Error) => error.message));
    expect(said.startsWith("GitHub answered 403 (rate limit reached): xxx")).toBe(true);
    expect(said.length).toBeLessThan(260);
    const html = connector(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(html.upstream({ record, args })).rejects.toThrow("GitHub answered 502 with something that is not JSON");
    const huge = connector(() => new Response("x".repeat(MAX_GITHUB_REPLY_BYTES + 1)));
    await expect(huge.upstream({ record, args })).rejects.toThrow("larger than the connector reads");
  });

  it("returns a file's text, and says so when a file is not text", async () => {
    const record = await recordFor("get_file_contents");
    const args = { owner: "octo", repo: "demo", path: "README.md" };
    const text = connector(() => Response.json({ type: "file", path: "README.md", sha: "abc", size: 12, encoding: "base64", content: btoa("# Demo\nhello"), download_url: "https://raw.example/x" }));
    expect(await text.upstream({ record, args })).toEqual({ type: "file", path: "README.md", sha: "abc", size: 12, content: "# Demo\nhello" });
    const binary = connector(() => Response.json({ type: "file", path: "logo.png", sha: "def", size: 4, encoding: "base64", content: btoa(String.fromCharCode(0xff, 0xfe, 0x00, 0xc3)) }));
    expect(await binary.upstream({ record, args })).toEqual({ type: "file", path: "logo.png", sha: "def", size: 4, content: null, binary: true });
    const folder = connector(() => Response.json([{ type: "file", path: "a.ts" }]));
    expect(await folder.upstream({ record, args })).toEqual([{ type: "file", path: "a.ts" }]);
  });

  it("refuses a call meant for another server", async () => {
    const { sent, upstream } = connector();
    await expect(upstream({ record: { ...(await recordFor("get_repository")), server: "slack" }, args: {} })).rejects.toThrow('was given a call for "slack"');
    expect(sent).toEqual([]);
  });
});

// A tool that is not marked sensitive is classed `internal`, and a read of it does not stop a later
// outbound call. GitHub's own reply for a list holds free text written by people (an issue's body, a
// pull request's description, release notes, a whole commit message), so the connector hands over
// only the named fields. (aramid review finding on src/tools/github-inventory.ts, 2026-11-26.)
describe("what a tool that is not marked sensitive hands over", () => {
  const SECRET_TEXT = "CLIENT-MATERIAL the client's unreleased pricing";
  const where = { owner: "octo", repo: "demo" };

  async function handedOver(tool: string, reply: unknown, args: Record<string, unknown> = where): Promise<unknown> {
    const { upstream } = connector(() => Response.json(reply));
    return upstream({ record: await recordFor(tool), args });
  }

  it("has a list of fields for every such tool, and for no sensitive one", () => {
    const plain = GITHUB_READ_ONLY_TOOLS.filter((tool) => !tool.sensitive).map((tool) => tool.tool).sort();
    expect(plain).toEqual(["get_repository", "list_branches", "list_commits", "list_issues", "list_pull_requests", "list_releases", "list_workflow_runs"]);
    expect([...GITHUB_METADATA_ONLY_TOOLS].sort()).toEqual(plain);
  });

  it("gives an issue's number, title, state, labels and people, and not its body", async () => {
    const out = await handedOver("list_issues", [
      {
        number: 7,
        title: "Checkout fails",
        state: "open",
        body: SECRET_TEXT,
        body_text: SECRET_TEXT,
        comments: 3,
        created_at: "2026-11-01T00:00:00Z",
        html_url: "https://github.com/octo/demo/issues/7",
        user: { login: "ada", email: "ada@example.com", bio: SECRET_TEXT },
        labels: [{ name: "bug", description: SECRET_TEXT }],
        assignees: [{ login: "bo", site_admin: false }],
        milestone: { title: "v2", number: 1, description: SECRET_TEXT },
        pull_request: { html_url: "https://github.com/octo/demo/pull/7", merged_at: null },
        reactions: { total_count: 1 },
      },
    ]);
    expect(out).toEqual([
      {
        number: 7,
        title: "Checkout fails",
        state: "open",
        comments: 3,
        created_at: "2026-11-01T00:00:00Z",
        html_url: "https://github.com/octo/demo/issues/7",
        user: { login: "ada" },
        labels: [{ name: "bug" }],
        assignees: [{ login: "bo" }],
        milestone: { title: "v2", number: 1 },
        pull_request: { html_url: "https://github.com/octo/demo/pull/7", merged_at: null },
      },
    ]);
  });

  it("gives a pull request's number, title, state, branches and author, and not its description", async () => {
    const out = await handedOver("list_pull_requests", [
      {
        number: 9,
        title: "Add totals",
        state: "open",
        draft: false,
        body: SECRET_TEXT,
        user: { login: "ada" },
        head: { ref: "totals", sha: "abc", label: "octo:totals", repo: { full_name: "octo/demo", description: SECRET_TEXT } },
        base: { ref: "main", sha: "def", label: "octo:main", repo: { full_name: "octo/demo" } },
        merged_at: null,
      },
    ]);
    expect(out).toEqual([
      {
        number: 9,
        title: "Add totals",
        state: "open",
        draft: false,
        user: { login: "ada" },
        head: { ref: "totals", sha: "abc", label: "octo:totals", repo: { full_name: "octo/demo" } },
        base: { ref: "main", sha: "def", label: "octo:main", repo: { full_name: "octo/demo" } },
        merged_at: null,
      },
    ]);
  });

  it("gives a release's tag, name and dates, and not its notes", async () => {
    const out = await handedOver("list_releases", [{ id: 1, tag_name: "v1.0.0", name: "First", draft: false, prerelease: false, published_at: "2026-11-02T00:00:00Z", body: SECRET_TEXT, author: { login: "ada" } }]);
    expect(out).toEqual([{ id: 1, tag_name: "v1.0.0", name: "First", draft: false, prerelease: false, published_at: "2026-11-02T00:00:00Z", author: { login: "ada" } }]);
  });

  it("gives a commit's SHA, author, date and the first line of its message", async () => {
    const out = await handedOver("list_commits", [
      {
        sha: "abc",
        html_url: "https://github.com/octo/demo/commit/abc",
        commit: { author: { name: "Ada", email: "ada@example.com", date: "2026-11-03T00:00:00Z" }, message: `Fix the totals\r\n\r\n${SECRET_TEXT}`, comment_count: 0 },
        author: { login: "ada", id: 5 },
        parents: [{ sha: "000", url: "https://api.github.com/x" }],
      },
      { sha: "def", commit: { author: { name: "Bo", date: "2026-11-04T00:00:00Z" }, message: "x".repeat(500) }, author: null },
    ]);
    expect(out).toEqual([
      {
        sha: "abc",
        html_url: "https://github.com/octo/demo/commit/abc",
        commit: { author: { name: "Ada", date: "2026-11-03T00:00:00Z" }, message: "Fix the totals", comment_count: 0 },
        author: { login: "ada" },
        parents: [{ sha: "000" }],
      },
      { sha: "def", commit: { author: { name: "Bo", date: "2026-11-04T00:00:00Z" }, message: "x".repeat(200) }, author: null },
    ]);
  });

  it("gives a CI run's status, branch and timing, and only the first line of its commit's message", async () => {
    const out = await handedOver("list_workflow_runs", {
      total_count: 1,
      workflow_runs: [
        { id: 4, name: "CI", display_title: "Add totals", status: "completed", conclusion: "success", head_branch: "main", head_sha: "abc", run_number: 12, created_at: "2026-11-05T00:00:00Z", head_commit: { id: "abc", message: `Add totals\n\n${SECRET_TEXT}`, author: { email: "ada@example.com" } }, repository: { description: SECRET_TEXT } },
      ],
    });
    expect(out).toEqual({
      total_count: 1,
      workflow_runs: [{ id: 4, name: "CI", display_title: "Add totals", status: "completed", conclusion: "success", head_branch: "main", head_sha: "abc", run_number: 12, created_at: "2026-11-05T00:00:00Z", head_commit: { id: "abc", message: "Add totals" } }],
    });
  });

  it("gives a repository's and a branch's details without anything nested it has no field for", async () => {
    const repository = await handedOver("get_repository", { id: 1, name: "demo", full_name: "octo/demo", private: true, visibility: "private", default_branch: "main", topics: ["shop", { odd: SECRET_TEXT }], open_issues_count: 2, owner: { login: "octo", email: "o@example.com" }, license: { spdx_id: "MIT", body: SECRET_TEXT }, template_repository: { description: SECRET_TEXT } });
    expect(repository).toEqual({ id: 1, name: "demo", full_name: "octo/demo", private: true, visibility: "private", default_branch: "main", topics: ["shop"], open_issues_count: 2, owner: { login: "octo" }, license: { spdx_id: "MIT" } });
    const branches = await handedOver("list_branches", [{ name: "main", protected: true, commit: { sha: "abc", url: "https://api.github.com/x" }, protection: { note: SECRET_TEXT } }]);
    expect(branches).toEqual([{ name: "main", protected: true, commit: { sha: "abc" } }]);
  });

  it("hands over nothing a person wrote at length, whatever field GitHub puts it in", async () => {
    const anywhere = { body: SECRET_TEXT, description_html: SECRET_TEXT, note: SECRET_TEXT, nested: { deeper: [SECRET_TEXT] } };
    for (const tool of ["list_issues", "list_pull_requests", "list_releases", "list_commits", "list_branches"]) {
      expect(JSON.stringify(await handedOver(tool, [{ ...anywhere, user: anywhere, commit: anywhere, head: anywhere, author: anywhere }])), tool).not.toContain("CLIENT-MATERIAL");
    }
  });

  it("refuses a reply that is not the kind of thing the tool lists", async () => {
    await expect(handedOver("list_issues", { message: SECRET_TEXT })).rejects.toThrow("GitHub's reply is not in the form this tool reads");
    await expect(handedOver("list_workflow_runs", [1, 2])).rejects.toThrow("GitHub's reply is not in the form this tool reads");
  });

  it("leaves a sensitive tool's reply as GitHub gave it", async () => {
    const issue = { number: 7, title: "Checkout fails", body: SECRET_TEXT };
    expect(await handedOver("get_issue", issue, { ...where, issue_number: 7 })).toEqual(issue);
  });
});
