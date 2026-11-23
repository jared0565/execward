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
  /** Reads the credential from the secret store, at the moment a request is sent. */
  readonly token: () => string | undefined;
  readonly fetch: (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual" }) => Promise<Response>;
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
    const token = deps.token();
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
    if (response.status >= 300 && response.status < 400) throw new UpstreamToolError(`GitHub answered ${response.status}, a redirect, which is not followed`);

    const body = await response.text();
    if (body.length > MAX_GITHUB_REPLY_BYTES) throw new UpstreamToolError("GitHub's reply is larger than the connector reads");
    let parsed: unknown;
    try {
      parsed = body === "" ? null : JSON.parse(body);
    } catch {
      throw new UpstreamToolError(`GitHub answered ${response.status} with something that is not JSON`);
    }
    if (!response.ok) {
      const said = typeof parsed === "object" && parsed !== null && typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : "";
      const limited = response.headers.get("x-ratelimit-remaining") === "0" ? " (rate limit reached)" : "";
      throw new UpstreamToolError(scrub(`GitHub answered ${response.status}${limited}: ${said.slice(0, 200)}`));
    }
    if (record.tool === "get_file_contents" && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const file = parsed as { type?: unknown; path?: unknown; sha?: unknown; size?: unknown; encoding?: unknown; content?: unknown };
      const text = file.encoding === "base64" && typeof file.content === "string" ? decodeBase64(file.content) : undefined;
      return { type: file.type, path: file.path, sha: file.sha, size: file.size, ...(text === undefined ? { content: null, binary: true } : { content: text }) };
    }
    return parsed;
  };
}
