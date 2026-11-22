/**
 * The GitHub read-only actions ExecWard wraps first, each with a draft policy
 * record (task 0.1.5). The connector that implements them is task 1.5.1.
 *
 * A draft has every policy field except `definitionHash`, which exists only once
 * the tool's definition is written and pinned (task 1.5.4).
 */
import type { PolicyRecord } from "../contracts/policy";

export type DraftPolicyRecord = Omit<PolicyRecord, "definitionHash" | "destinationAllowlist"> & {
  readonly destinationAllowlist: readonly string[];
  /** The GitHub REST endpoint the tool reads. */
  readonly endpoint: string;
  readonly summary: string;
};

/** Fields shared by every tool in this inventory: read-only, callable either way. */
const READ_ONLY = {
  server: "github",
  callerRule: "both",
  tier: 0,
  outbound: false,
  destinationAllowlist: [],
  quotas: {},
} as const;

/**
 * Tools that return names, numbers, states and titles. A private repository's
 * metadata is internal, not public.
 */
const METADATA = { ...READ_ONLY, dataClass: "internal", sensitive: false } as const;

/**
 * Tools that return source code, diffs or free text written by people. In a
 * private repository that can hold client material, so these are confidential
 * and sensitive: a run that used one cannot then call an outbound tool (FR-29).
 */
const CONTENT = { ...READ_ONLY, dataClass: "confidential", sensitive: true } as const;

export const GITHUB_READ_ONLY_TOOLS: readonly DraftPolicyRecord[] = [
  {
    ...METADATA,
    tool: "get_repository",
    endpoint: "GET /repos/{owner}/{repo}",
    summary: "Repository details: visibility, default branch, topics, counts.",
  },
  {
    ...METADATA,
    tool: "list_branches",
    endpoint: "GET /repos/{owner}/{repo}/branches",
    summary: "Branch names and their head commits.",
  },
  {
    ...METADATA,
    tool: "list_commits",
    endpoint: "GET /repos/{owner}/{repo}/commits",
    summary: "Commit history for a branch or path: SHA, author, date, message.",
  },
  {
    ...CONTENT,
    tool: "get_commit",
    endpoint: "GET /repos/{owner}/{repo}/commits/{ref}",
    summary: "One commit with its changed files and diff.",
  },
  {
    ...CONTENT,
    tool: "get_file_contents",
    endpoint: "GET /repos/{owner}/{repo}/contents/{path}",
    summary: "A file's contents, or a directory listing, at a ref.",
  },
  {
    ...CONTENT,
    tool: "search_code",
    endpoint: "GET /search/code",
    summary: "Code search results with matching fragments.",
  },
  {
    ...METADATA,
    tool: "list_issues",
    endpoint: "GET /repos/{owner}/{repo}/issues",
    summary: "Issues with number, title, state, labels and assignees.",
  },
  {
    ...CONTENT,
    tool: "get_issue",
    endpoint: "GET /repos/{owner}/{repo}/issues/{issue_number}",
    summary: "One issue with its full body.",
  },
  {
    ...CONTENT,
    tool: "list_issue_comments",
    endpoint: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    summary: "The comments on an issue or pull request.",
  },
  {
    ...CONTENT,
    tool: "search_issues",
    endpoint: "GET /search/issues",
    summary: "Issue and pull request search results, with text matches.",
  },
  {
    ...METADATA,
    tool: "list_pull_requests",
    endpoint: "GET /repos/{owner}/{repo}/pulls",
    summary: "Pull requests with number, title, state, branches and author.",
  },
  {
    ...CONTENT,
    tool: "get_pull_request",
    endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    summary: "One pull request with its full description and merge state.",
  },
  {
    ...CONTENT,
    tool: "list_pull_request_files",
    endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    summary: "The files a pull request changes, with patches.",
  },
  {
    ...METADATA,
    tool: "list_releases",
    endpoint: "GET /repos/{owner}/{repo}/releases",
    summary: "Releases with tag, name and publish date.",
  },
  {
    ...METADATA,
    tool: "list_workflow_runs",
    endpoint: "GET /repos/{owner}/{repo}/actions/runs",
    summary: "CI runs with status, conclusion, branch and timing.",
  },
];
