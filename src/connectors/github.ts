/**
 * The GitHub read-only connector (task 1.5.1).
 *
 * It turns one allowed call from the broker into one GET request to GitHub's
 * REST API. Three things are fixed here and cannot be changed by a script:
 *
 *   - the host: every request goes to api.github.com;
 *   - the method: every request is a GET. There is no code path that writes;
 *   - the credential: it is read from the host's secret store when a request
 *     is sent, and is never in a script's inputs, a result or an error.
 *
 * The tools are the fifteen in ../tools/github-inventory.ts. A tool's
 * arguments are checked by the broker against the schema below before this
 * code runs, and checked again here where they become part of a URL.
 */
import type { Upstream } from "../broker/broker";
import { UpstreamToolError } from "../broker/broker";
import type { PolicyRecord } from "../contracts/policy";
import { approve, type Pin } from "../registry/registry";
import type { ToolDefinitionRecord } from "../registry/definition";
import { GITHUB_READ_ONLY_TOOLS } from "../tools/github-inventory";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
/** The largest reply the connector will read. A larger one is refused, not cut. */
export const MAX_GITHUB_REPLY_BYTES = 2 * 1024 * 1024;

interface Param {
  readonly name: string;
  readonly in: "path" | "query";
  readonly schema: Readonly<Record<string, unknown>>;
  readonly required?: boolean;
}

interface Spec {
  readonly tool: string;
  /** Path on api.github.com, with `{name}` for each path argument. */
  readonly path: string;
  readonly params: readonly Param[];
}

const NAME = { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_.-]+$" } as const;
const REF = { type: "string", minLength: 1, maxLength: 250, pattern: "^[A-Za-z0-9_./-]+$" } as const;
const NUMBER = { type: "integer", minimum: 1, maximum: 100_000_000 } as const;
const QUERY = { type: "string", minLength: 1, maxLength: 256 } as const;

const OWNER: Param = { name: "owner", in: "path", required: true, schema: { ...NAME, description: "The account that owns the repository." } };
const REPO: Param = { name: "repo", in: "path", required: true, schema: { ...NAME, description: "The repository name." } };
const PAGING: readonly Param[] = [
  { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, description: "Results per page. Default 30." } },
  { name: "page", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, description: "Page number, from 1." } },
];
const STATE: Param = { name: "state", in: "query", schema: { type: "string", enum: ["open", "closed", "all"], description: "Default open." } };
const DIRECTION: Param = { name: "direction", in: "query", schema: { type: "string", enum: ["asc", "desc"] } };

const SPECS: readonly Spec[] = [
  { tool: "get_repository", path: "/repos/{owner}/{repo}", params: [OWNER, REPO] },
  { tool: "list_branches", path: "/repos/{owner}/{repo}/branches", params: [OWNER, REPO, ...PAGING] },
  {
    tool: "list_commits",
    path: "/repos/{owner}/{repo}/commits",
    params: [
      OWNER,
      REPO,
      { name: "sha", in: "query", schema: { ...REF, description: "Branch name or commit SHA to start from. Default: the default branch." } },
      { name: "path", in: "query", schema: { type: "string", minLength: 1, maxLength: 500, description: "Only commits touching this file path." } },
      { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "until", in: "query", schema: { type: "string", format: "date-time" } },
      ...PAGING,
    ],
  },
  { tool: "get_commit", path: "/repos/{owner}/{repo}/commits/{ref}", params: [OWNER, REPO, { name: "ref", in: "path", required: true, schema: { ...REF, description: "Commit SHA, branch or tag." } }] },
  {
    tool: "get_file_contents",
    path: "/repos/{owner}/{repo}/contents/{path}",
    params: [
      OWNER,
      REPO,
      { name: "path", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 500, description: "File or folder path inside the repository." } },
      { name: "ref", in: "query", schema: { ...REF, description: "Branch, tag or commit SHA. Default: the default branch." } },
    ],
  },
  { tool: "search_code", path: "/search/code", params: [{ name: "q", in: "query", required: true, schema: { ...QUERY, description: "GitHub code search query." } }, ...PAGING] },
  {
    tool: "list_issues",
    path: "/repos/{owner}/{repo}/issues",
    params: [
      OWNER,
      REPO,
      STATE,
      { name: "labels", in: "query", schema: { type: "string", minLength: 1, maxLength: 200, description: "Label names, separated by commas." } },
      { name: "sort", in: "query", schema: { type: "string", enum: ["created", "updated", "comments"] } },
      DIRECTION,
      { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
      ...PAGING,
    ],
  },
  { tool: "get_issue", path: "/repos/{owner}/{repo}/issues/{issue_number}", params: [OWNER, REPO, { name: "issue_number", in: "path", required: true, schema: NUMBER }] },
  { tool: "list_issue_comments", path: "/repos/{owner}/{repo}/issues/{issue_number}/comments", params: [OWNER, REPO, { name: "issue_number", in: "path", required: true, schema: NUMBER }, ...PAGING] },
  {
    tool: "search_issues",
    path: "/search/issues",
    params: [
      { name: "q", in: "query", required: true, schema: { ...QUERY, description: "GitHub issue and pull request search query." } },
      { name: "sort", in: "query", schema: { type: "string", enum: ["comments", "created", "updated"] } },
      { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
      ...PAGING,
    ],
  },
  {
    tool: "list_pull_requests",
    path: "/repos/{owner}/{repo}/pulls",
    params: [
      OWNER,
      REPO,
      STATE,
      { name: "base", in: "query", schema: { ...REF, description: "Only pull requests into this branch." } },
      { name: "sort", in: "query", schema: { type: "string", enum: ["created", "updated", "popularity", "long-running"] } },
      DIRECTION,
      ...PAGING,
    ],
  },
  { tool: "get_pull_request", path: "/repos/{owner}/{repo}/pulls/{pull_number}", params: [OWNER, REPO, { name: "pull_number", in: "path", required: true, schema: NUMBER }] },
  { tool: "list_pull_request_files", path: "/repos/{owner}/{repo}/pulls/{pull_number}/files", params: [OWNER, REPO, { name: "pull_number", in: "path", required: true, schema: NUMBER }, ...PAGING] },
  { tool: "list_releases", path: "/repos/{owner}/{repo}/releases", params: [OWNER, REPO, ...PAGING] },
  {
    tool: "list_workflow_runs",
    path: "/repos/{owner}/{repo}/actions/runs",
    params: [
      OWNER,
      REPO,
      { name: "branch", in: "query", schema: REF },
      { name: "status", in: "query", schema: { type: "string", enum: ["completed", "in_progress", "queued", "success", "failure", "cancelled"] } },
      ...PAGING,
    ],
  },
];

const SPEC_BY_TOOL = new Map(SPECS.map((spec) => [spec.tool, spec]));

function definitionOf(spec: Spec): ToolDefinitionRecord {
  const draft = GITHUB_READ_ONLY_TOOLS.find((tool) => tool.tool === spec.tool);
  if (!draft) throw new Error(`"${spec.tool}" is not in the GitHub inventory`);
  return {
    server: "github",
    tool: spec.tool,
    description: `${draft.summary} Read-only.`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(spec.params.map((param) => [param.name, param.schema])),
      required: spec.params.filter((param) => param.required).map((param) => param.name),
      additionalProperties: false,
    },
  };
}

/** What each tool says about itself: the definitions the registry pins (FR-22). */
export const GITHUB_TOOL_DEFINITIONS: readonly ToolDefinitionRecord[] = SPECS.map(definitionOf);

/** Approves every definition and returns each tool's pin and its finished policy record. */
export async function githubPinsAndPolicy(): Promise<{ readonly pins: Pin[]; readonly records: PolicyRecord[] }> {
  const pins: Pin[] = [];
  const records: PolicyRecord[] = [];
  for (const definition of GITHUB_TOOL_DEFINITIONS) {
    const pin = await approve(definition);
    const draft = GITHUB_READ_ONLY_TOOLS.find((tool) => tool.tool === definition.tool);
    if (!draft) throw new Error(`"${definition.tool}" is not in the GitHub inventory`);
    pins.push(pin);
    records.push({
      server: draft.server,
      tool: draft.tool,
      definitionHash: pin.hash,
      callerRule: draft.callerRule,
      dataClass: draft.dataClass,
      tier: draft.tier,
      sensitive: draft.sensitive,
      outbound: draft.outbound,
      destinationAllowlist: [...draft.destinationAllowlist],
      quotas: { ...draft.quotas },
    });
  }
  return { pins, records };
}

function segment(value: unknown, name: string, slashes: "refuse" | "encode" = "refuse"): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  const control = typeof text === "string" && [...text].some((char) => (char.codePointAt(0) ?? 0) < 0x20);
  if (typeof text !== "string" || text === "" || text === "." || text === ".." || control || /[\\?#%]/.test(text) || (slashes === "refuse" && text.includes("/"))) {
    throw new UpstreamToolError(`the argument "${name}" is not usable in a GitHub address`);
  }
  return encodeURIComponent(text);
}

/** Builds the one address a call may reach. Exported for tests. */
export function githubRequestUrl(tool: string, args: unknown): string {
  const spec = SPEC_BY_TOOL.get(tool);
  if (!spec) throw new UpstreamToolError(`the GitHub connector has no tool named "${tool.slice(0, 60)}"`);
  const given = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  let path = spec.path;
  const query = new URLSearchParams();
  for (const param of spec.params) {
    const value = given[param.name];
    if (value === undefined) {
      if (param.required) throw new UpstreamToolError(`the argument "${param.name}" is required`);
      continue;
    }
    if (param.in === "query") {
      if (typeof value !== "string" && typeof value !== "number") throw new UpstreamToolError(`the argument "${param.name}" must be text or a number`);
      query.set(param.name, String(value));
    } else if (param.name === "path") {
      // A file path keeps its slashes; every part between them is checked and encoded on its own.
      const parts = String(value).split("/").filter((part) => part !== "");
      if (parts.length === 0) throw new UpstreamToolError(`the argument "path" is empty`);
      path = path.replace("{path}", parts.map((part) => segment(part, "path")).join("/"));
    } else {
      // A branch name may hold a slash. It is encoded, so it stays one part of the address.
      path = path.replace(`{${param.name}}`, segment(value, param.name, param.name === "ref" ? "encode" : "refuse"));
    }
  }
  const url = new URL(`${GITHUB_API}${path}`);
  url.search = query.toString();
  // Whatever the arguments were, the request stays on GitHub's API host.
  if (url.origin !== GITHUB_API || url.pathname.includes("/../") || url.pathname.endsWith("/..")) {
    throw new UpstreamToolError("the arguments do not make a GitHub API address");
  }
  return url.toString();
}

export interface GithubConnectorDeps {
  /**
   * Gives the credential at the moment a request is sent: a token read from the secret
   * store, or one minted for a GitHub App (./github-app.ts). `undefined` when there is none.
   */
  readonly token: () => string | undefined | Promise<string | undefined>;
  readonly fetch: (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual" }) => Promise<Response>;
}

/**
 * Which parts of GitHub's reply a tool hands over, for the tools that are not marked
 * sensitive. Their policy says they return names, numbers, states and titles, and a read
 * of one does not stop a later outbound call (FR-29). GitHub's reply holds more: an
 * issue's body, a pull request's description, release notes, whole commit messages,
 * email addresses. So the reply is not passed on. A copy is built that holds the fields
 * named here and nothing else, in the places GitHub puts them, so a script written for
 * GitHub's own form still reads them.
 *
 *   "value"       a number, true, false or null, or text: its first line, at most `TITLE_CHARS` long
 *   "values"      a list of those
 *   "first_line"  the same cut, named for a field that is a title or a message
 *   { ... }       an object, with these fields of it
 *   [shape]       a list, each item in this form
 */
type Shape = "value" | "values" | "first_line" | { readonly [field: string]: Shape } | readonly [Shape];

/** The longest text handed over by one of these tools. */
const TITLE_CHARS = 200;

const PERSON: Shape = { login: "value" };
const PEOPLE: Shape = [PERSON];
const LABELS: Shape = [{ name: "value" }];
const MILESTONE: Shape = { title: "value", number: "value", state: "value", due_on: "value" };
const BRANCH_END: Shape = { ref: "value", sha: "value", label: "value", repo: { full_name: "value" } };
const SIGNER: Shape = { name: "value", date: "value" };

const SHAPES: Readonly<Record<string, Shape>> = {
  get_repository: {
    id: "value",
    name: "value",
    full_name: "value",
    private: "value",
    visibility: "value",
    fork: "value",
    archived: "value",
    disabled: "value",
    default_branch: "value",
    description: "first_line",
    language: "value",
    topics: "values",
    html_url: "value",
    created_at: "value",
    updated_at: "value",
    pushed_at: "value",
    size: "value",
    stargazers_count: "value",
    watchers_count: "value",
    forks_count: "value",
    open_issues_count: "value",
    subscribers_count: "value",
    has_issues: "value",
    has_wiki: "value",
    has_discussions: "value",
    owner: { login: "value", type: "value" },
    license: { spdx_id: "value", name: "value" },
  },
  list_branches: [{ name: "value", protected: "value", commit: { sha: "value" } }],
  list_commits: [
    {
      sha: "value",
      html_url: "value",
      commit: { author: SIGNER, committer: SIGNER, message: "first_line", comment_count: "value" },
      author: PERSON,
      committer: PERSON,
      parents: [{ sha: "value" }],
    },
  ],
  list_issues: [
    {
      number: "value",
      title: "first_line",
      state: "value",
      state_reason: "value",
      locked: "value",
      draft: "value",
      comments: "value",
      created_at: "value",
      updated_at: "value",
      closed_at: "value",
      html_url: "value",
      author_association: "value",
      user: PERSON,
      assignee: PERSON,
      assignees: PEOPLE,
      labels: LABELS,
      milestone: MILESTONE,
      pull_request: { html_url: "value", merged_at: "value" },
    },
  ],
  list_pull_requests: [
    {
      number: "value",
      title: "first_line",
      state: "value",
      locked: "value",
      draft: "value",
      created_at: "value",
      updated_at: "value",
      closed_at: "value",
      merged_at: "value",
      merge_commit_sha: "value",
      html_url: "value",
      author_association: "value",
      user: PERSON,
      assignee: PERSON,
      assignees: PEOPLE,
      requested_reviewers: PEOPLE,
      labels: LABELS,
      milestone: MILESTONE,
      head: BRANCH_END,
      base: BRANCH_END,
    },
  ],
  list_releases: [
    {
      id: "value",
      tag_name: "value",
      name: "first_line",
      target_commitish: "value",
      draft: "value",
      prerelease: "value",
      created_at: "value",
      published_at: "value",
      html_url: "value",
      author: PERSON,
      assets: [{ name: "value", size: "value", content_type: "value", download_count: "value", created_at: "value", updated_at: "value" }],
    },
  ],
  list_workflow_runs: {
    total_count: "value",
    workflow_runs: [
      {
        id: "value",
        name: "first_line",
        display_title: "first_line",
        run_number: "value",
        run_attempt: "value",
        event: "value",
        status: "value",
        conclusion: "value",
        workflow_id: "value",
        path: "value",
        head_branch: "value",
        head_sha: "value",
        created_at: "value",
        updated_at: "value",
        run_started_at: "value",
        html_url: "value",
        actor: PERSON,
        triggering_actor: PERSON,
        head_commit: { id: "value", message: "first_line", timestamp: "value" },
        pull_requests: [{ number: "value" }],
      },
    ],
  },
};

/** The tools whose reply is cut down to named fields: every tool that is not marked sensitive. */
export const GITHUB_METADATA_ONLY_TOOLS: ReadonlySet<string> = new Set(Object.keys(SHAPES));

/** Marks a part that is not handed over. `undefined` cannot serve: JSON has no such value, and `null` is a real one. */
const LEFT_OUT = Symbol("left out");

const isPlain = (value: unknown): value is string | number | boolean | null => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The characters that end a line: line feed, carriage return, and the two Unicode line breaks. */
const LINE_ENDS: ReadonlySet<number> = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

/**
 * The first line of some text, at most `TITLE_CHARS` long. Every string these tools hand over
 * goes through this, not only titles: a milestone's title, a signer's name, a branch name or an
 * asset's name is written by a person too, and could otherwise carry any amount of text through
 * a read that does not block a later outbound call. A lone carriage return and the two Unicode
 * line breaks end a line as well.
 */
function oneLine(text: string): string {
  let end = 0;
  while (end < text.length && end < TITLE_CHARS && !LINE_ENDS.has(text.charCodeAt(end))) end += 1;
  return text.slice(0, end);
}

function shaped(value: unknown, shape: Shape): unknown {
  if (shape === "value") return typeof value === "string" ? oneLine(value) : isPlain(value) ? value : LEFT_OUT;
  if (shape === "values") return Array.isArray(value) ? value.filter(isPlain).map((item) => (typeof item === "string" ? oneLine(item) : item)) : LEFT_OUT;
  if (shape === "first_line") {
    if (value === null) return null;
    return typeof value === "string" ? oneLine(value) : LEFT_OUT;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return LEFT_OUT;
    const each = (shape as readonly [Shape])[0];
    return value.map((item) => shaped(item, each)).filter((item) => item !== LEFT_OUT);
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return LEFT_OUT;
  const out: Record<string, unknown> = {};
  for (const [field, inner] of Object.entries(shape as { readonly [field: string]: Shape })) {
    if (!Object.hasOwn(value, field)) continue;
    const kept = shaped((value as Record<string, unknown>)[field], inner);
    if (kept !== LEFT_OUT) out[field] = kept;
  }
  return out;
}

function decodeBase64(text: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(text.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not text: an image, an archive. The caller gets the details without the content.
    return undefined;
  }
}

/** The broker's `upstream` for tools whose server is "github". */
export function githubUpstream(deps: GithubConnectorDeps): Upstream {
  return async ({ record, args }) => {
    if (record.server !== "github") throw new Error(`the GitHub connector was given a call for "${record.server}"`);
    const url = githubRequestUrl(record.tool, args);
    const token = await deps.token();
    if (typeof token !== "string" || token === "") throw new UpstreamToolError("the GitHub connector has no credential");
    // Nothing GitHub says may carry the credential back to the script.
    const scrub = (text: string): string => text.split(token).join("[removed]");

    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "GET",
        // A redirect is not followed: the credential goes to api.github.com and nowhere else.
        redirect: "manual",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": GITHUB_API_VERSION,
          "user-agent": "execward",
        },
      });
    } catch {
      // The error's own text can hold the request. It is not passed on.
      throw new UpstreamToolError("GitHub could not be reached");
    }
    if (response.status >= 300 && response.status < 400) throw new UpstreamToolError(`GitHub answered ${response.status}, a redirect, which is not followed`, response.status);

    const body = await response.text();
    if (body.length > MAX_GITHUB_REPLY_BYTES) throw new UpstreamToolError("GitHub's reply is larger than the connector reads");
    let parsed: unknown;
    try {
      parsed = body === "" ? null : JSON.parse(body);
    } catch {
      throw new UpstreamToolError(`GitHub answered ${response.status} with something that is not JSON`, response.status);
    }
    if (!response.ok) {
      const said = typeof parsed === "object" && parsed !== null && typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : "";
      const limited = response.headers.get("x-ratelimit-remaining") === "0" ? " (rate limit reached)" : "";
      throw new UpstreamToolError(scrub(`GitHub answered ${response.status}${limited}: ${said.slice(0, 200)}`), response.status);
    }
    if (record.tool === "get_file_contents" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const file = parsed as { type?: unknown; path?: unknown; sha?: unknown; size?: unknown; encoding?: unknown; content?: unknown };
      const text = file.encoding === "base64" && typeof file.content === "string" ? decodeBase64(file.content) : undefined;
      return { type: file.type, path: file.path, sha: file.sha, size: file.size, ...(text === undefined ? { content: null, binary: true } : { content: text }) };
    }
    const shape = SHAPES[record.tool];
    // A sensitive tool's reply is handed over as it is: the run is then held to the rules for sensitive data.
    if (shape === undefined) {
      if (!record.sensitive) throw new UpstreamToolError("this tool is not marked sensitive and has no list of fields to hand over");
      return parsed;
    }
    const kept = shaped(parsed, shape);
    // A list where an object was expected, or the other way round. Nothing of it is passed on.
    if (kept === LEFT_OUT || kept === null) throw new UpstreamToolError("GitHub's reply is not in the form this tool reads");
    return kept;
  };
}
