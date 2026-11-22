/**
 * The 15 read-only GitHub tools of the inventory (task 0.1.5), answered from the
 * invented world in `world.ts`. Responses carry the fields and nesting of GitHub's
 * REST API, so a tool result costs about what a real one would, but nothing is
 * fetched and nothing leaves the machine.
 *
 * One deliberate difference from REST: file contents come back as text, not
 * base64, as a connector would hand them to a model.
 */
import { z } from "zod";
import type { ToolBackend, ToolDefinition } from "../types";
import {
  buildWorld,
  stableNumber,
  type World,
  type WorldChange,
  type WorldCommit,
  type WorldIssue,
  type WorldRepo,
} from "./world";

const API = "https://api.github.com";
const WEB = "https://github.com";

/** A request the fixture refuses, worded like GitHub's own error. */
class GitHubError extends Error {
  constructor(status: number, message: string) {
    super(`${status} ${message}`);
  }
}

const repoArgs = {
  owner: z.string().describe("Account that owns the repository"),
  repo: z.string().describe("Repository name, without the owner"),
};
const pageArgs = {
  per_page: z.number().int().min(1).max(100).optional().describe("Results per page, default 30"),
  page: z.number().int().min(1).optional().describe("Page number, default 1"),
};

function paginate<T>(items: readonly T[], args: { per_page?: number | undefined; page?: number | undefined }): T[] {
  const size = args.per_page ?? 30;
  const start = ((args.page ?? 1) - 1) * size;
  return items.slice(start, start + size);
}

function user(login: string) {
  const url = `${API}/users/${login}`;
  return {
    login,
    id: stableNumber(`user:${login}`),
    node_id: `U_${stableNumber(`node:${login}`).toString(36)}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${stableNumber(`user:${login}`)}?v=4`,
    gravatar_id: "",
    url,
    html_url: `${WEB}/${login}`,
    followers_url: `${url}/followers`,
    following_url: `${url}/following{/other_user}`,
    gists_url: `${url}/gists{/gist_id}`,
    starred_url: `${url}/starred{/owner}{/repo}`,
    subscriptions_url: `${url}/subscriptions`,
    organizations_url: `${url}/orgs`,
    repos_url: `${url}/repos`,
    events_url: `${url}/events{/privacy}`,
    received_events_url: `${url}/received_events`,
    type: "User",
    user_view_type: "public",
    site_admin: false,
  };
}

function repoUrl(repo: WorldRepo): string {
  return `${API}/repos/${repo.owner}/${repo.name}`;
}

function repoHtml(repo: WorldRepo): string {
  return `${WEB}/${repo.owner}/${repo.name}`;
}

function isIssue(issue: WorldIssue): boolean {
  return issue.pull === null;
}

function repoSummary(repo: WorldRepo) {
  const url = repoUrl(repo);
  return {
    id: stableNumber(`repo:${repo.name}`),
    node_id: `R_${stableNumber(`node:${repo.name}`).toString(36)}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { ...user(repo.owner), type: "Organization" },
    html_url: repoHtml(repo),
    description: repo.description,
    fork: false,
    url,
  };
}

function repoDetail(repo: WorldRepo) {
  const url = repoUrl(repo);
  const openCount = repo.issues.filter((issue) => issue.state === "open").length;
  return {
    ...repoSummary(repo),
    branches_url: `${url}/branches{/branch}`,
    commits_url: `${url}/commits{/sha}`,
    contents_url: `${url}/contents/{+path}`,
    issues_url: `${url}/issues{/number}`,
    pulls_url: `${url}/pulls{/number}`,
    releases_url: `${url}/releases{/id}`,
    created_at: repo.createdAt,
    updated_at: repo.commits[0]?.date ?? repo.createdAt,
    pushed_at: repo.commits[0]?.date ?? repo.createdAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `${repoHtml(repo)}.git`,
    homepage: null,
    size: repo.files.reduce((total, file) => total + file.content.length, 0),
    stargazers_count: repo.stars,
    watchers_count: repo.stars,
    language: repo.language,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    // GitHub counts open pull requests in this number too.
    open_issues_count: openCount,
    license: null,
    topics: repo.topics,
    visibility: repo.private ? "private" : "public",
    forks: 0,
    open_issues: openCount,
    watchers: repo.stars,
    default_branch: repo.defaultBranch,
    subscribers_count: 4,
  };
}

function label(repo: WorldRepo, world: World, name: string) {
  const found = world.labels.find((candidate) => candidate.name === name);
  return {
    id: stableNumber(`label:${repo.name}:${name}`),
    node_id: `LA_${stableNumber(`node:label:${name}`).toString(36)}`,
    url: `${repoUrl(repo)}/labels/${encodeURIComponent(name)}`,
    name,
    color: found?.color ?? "ededed",
    default: true,
    description: found?.description ?? null,
  };
}

function issueShape(repo: WorldRepo, world: World, issue: WorldIssue) {
  const url = `${repoUrl(repo)}/issues/${issue.number}`;
  const kind = isIssue(issue) ? "issues" : "pull";
  const html = `${repoHtml(repo)}/${kind}/${issue.number}`;
  return {
    url,
    repository_url: repoUrl(repo),
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: html,
    id: stableNumber(`issue:${repo.name}:${issue.number}`),
    node_id: `I_${stableNumber(`node:issue:${repo.name}:${issue.number}`).toString(36)}`,
    number: issue.number,
    title: issue.title,
    user: user(issue.user),
    labels: issue.labels.map((name) => label(repo, world, name)),
    state: issue.state,
    locked: false,
    assignee: issue.assignees[0] === undefined ? null : user(issue.assignees[0]),
    assignees: issue.assignees.map(user),
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: "MEMBER",
    ...(issue.pull === null
      ? { state_reason: issue.state === "closed" ? "completed" : null }
      : {
          draft: issue.pull.draft,
          pull_request: {
            url: `${repoUrl(repo)}/pulls/${issue.number}`,
            html_url: html,
            diff_url: `${html}.diff`,
            patch_url: `${html}.patch`,
            merged_at: issue.pull.mergedAt,
          },
        }),
    body: issue.body,
  };
}

function pullShape(repo: WorldRepo, world: World, issue: WorldIssue, detail: boolean) {
  const pull = issue.pull;
  if (pull === null) throw new GitHubError(404, "Not Found");
  const url = `${repoUrl(repo)}/pulls/${issue.number}`;
  const html = `${repoHtml(repo)}/pull/${issue.number}`;
  const branch = (ref: string) => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha: ref === repo.defaultBranch ? (repo.commits[0]?.sha ?? "") : stableNumber(`${repo.name}:${ref}`).toString(16).padStart(40, "0"),
    user: { ...user(repo.owner), type: "Organization" },
    repo: repoSummary(repo),
  });
  return {
    url,
    id: stableNumber(`pull:${repo.name}:${issue.number}`),
    node_id: `PR_${stableNumber(`node:pull:${repo.name}:${issue.number}`).toString(36)}`,
    html_url: html,
    diff_url: `${html}.diff`,
    patch_url: `${html}.patch`,
    issue_url: `${repoUrl(repo)}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    user: user(issue.user),
    body: issue.body,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    merged_at: pull.mergedAt,
    assignee: issue.assignees[0] === undefined ? null : user(issue.assignees[0]),
    assignees: issue.assignees.map(user),
    requested_reviewers: [],
    labels: issue.labels.map((name) => label(repo, world, name)),
    milestone: null,
    draft: pull.draft,
    commits_url: `${url}/commits`,
    review_comments_url: `${url}/comments`,
    comments_url: `${repoUrl(repo)}/issues/${issue.number}/comments`,
    head: branch(pull.head),
    base: branch(pull.base),
    author_association: "MEMBER",
    ...(detail
      ? {
          merged: pull.merged,
          mergeable: issue.state === "open" ? true : null,
          mergeable_state: issue.state === "open" ? "clean" : "unknown",
          merged_by: pull.merged ? user(issue.assignees[0] ?? issue.user) : null,
          comments: issue.comments.length,
          review_comments: 0,
          commits: pull.files.length,
          additions: pull.files.reduce((total, file) => total + file.additions, 0),
          deletions: pull.files.reduce((total, file) => total + file.deletions, 0),
          changed_files: new Set(pull.files.map((file) => file.filename)).size,
        }
      : {}),
  };
}

function changeShape(repo: WorldRepo, ref: string, change: WorldChange) {
  return {
    sha: stableNumber(`${repo.name}:${ref}:${change.filename}`).toString(16).padStart(40, "0"),
    filename: change.filename,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    blob_url: `${repoHtml(repo)}/blob/${ref}/${change.filename}`,
    raw_url: `${repoHtml(repo)}/raw/${ref}/${change.filename}`,
    contents_url: `${repoUrl(repo)}/contents/${change.filename}?ref=${ref}`,
    patch: change.patch,
  };
}

function commitShape(repo: WorldRepo, commit: WorldCommit, detail: boolean) {
  const url = `${repoUrl(repo)}/commits/${commit.sha}`;
  const person = { name: commit.author, email: `${commit.author}@users.noreply.example`, date: commit.date };
  const index = repo.commits.indexOf(commit);
  const parent = repo.commits[index + 1];
  return {
    sha: commit.sha,
    node_id: `C_${stableNumber(`node:${commit.sha}`).toString(36)}`,
    commit: {
      author: person,
      committer: person,
      message: commit.message,
      tree: { sha: stableNumber(`tree:${commit.sha}`).toString(16).padStart(40, "0"), url: `${repoUrl(repo)}/git/trees/${commit.sha}` },
      url: `${repoUrl(repo)}/git/commits/${commit.sha}`,
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null },
    },
    url,
    html_url: `${repoHtml(repo)}/commit/${commit.sha}`,
    comments_url: `${url}/comments`,
    author: user(commit.author),
    committer: user(commit.author),
    parents: parent === undefined ? [] : [{ sha: parent.sha, url: `${repoUrl(repo)}/commits/${parent.sha}` }],
    ...(detail
      ? {
          stats: {
            total: commit.files.reduce((total, file) => total + file.additions + file.deletions, 0),
            additions: commit.files.reduce((total, file) => total + file.additions, 0),
            deletions: commit.files.reduce((total, file) => total + file.deletions, 0),
          },
          files: commit.files.map((file) => changeShape(repo, commit.sha, file)),
        }
      : {}),
  };
}

/** Splits a search query into `key:value` qualifiers and free words. */
function parseQuery(q: string, allowed: readonly string[]) {
  const qualifiers: { key: string; value: string }[] = [];
  const words: string[] = [];
  for (const match of q.matchAll(/([\w-]+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      if (!allowed.includes(match[1])) {
        throw new GitHubError(422, `Validation Failed: the qualifier "${match[1]}" is not supported here. Supported: ${allowed.join(", ")}`);
      }
      qualifiers.push({ key: match[1], value: match[2].replaceAll('"', "") });
    } else {
      words.push((match[3] ?? match[4] ?? "").toLowerCase());
    }
  }
  return { qualifiers, words };
}

interface FixtureTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  run(args: never): unknown;
}

function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>) => unknown,
): FixtureTool {
  return { name, description, schema, run };
}

function buildTools(world: World): FixtureTool[] {
  const findRepo = (owner: string, name: string): WorldRepo => {
    const repo = world.repos.find((candidate) => candidate.owner === owner && candidate.name === name);
    if (repo === undefined) throw new GitHubError(404, "Not Found");
    return repo;
  };
  const findIssue = (repo: WorldRepo, number: number): WorldIssue => {
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) throw new GitHubError(404, "Not Found");
    return issue;
  };
  const reposIn = (qualifiers: readonly { key: string; value: string }[]): WorldRepo[] =>
    world.repos.filter((repo) =>
      qualifiers.every(({ key, value }) =>
        key === "repo" ? value === `${repo.owner}/${repo.name}` : key === "org" || key === "user" ? value === repo.owner : true,
      ),
    );

  return [
    tool("get_repository", "Get a repository: visibility, default branch, topics and counts.", z.object(repoArgs), (args) =>
      repoDetail(findRepo(args.owner, args.repo)),
    ),

    tool("list_branches", "List a repository's branches with their head commits.", z.object({ ...repoArgs, ...pageArgs }), (args) => {
      const repo = findRepo(args.owner, args.repo);
      return paginate(repo.branches, args).map((branch) => ({
        name: branch.name,
        commit: { sha: branch.sha, url: `${repoUrl(repo)}/commits/${branch.sha}` },
        protected: branch.name === repo.defaultBranch,
      }));
    }),

    tool(
      "list_commits",
      "List commits, newest first. Can be narrowed by branch, file path, author and date.",
      z.object({
        ...repoArgs,
        sha: z.string().optional().describe("Branch name or commit SHA to start from, default the default branch"),
        path: z.string().optional().describe("Only commits that touch this file path"),
        author: z.string().optional().describe("Only commits by this GitHub login"),
        since: z.string().optional().describe("Only commits after this ISO 8601 time"),
        until: z.string().optional().describe("Only commits before this ISO 8601 time"),
        ...pageArgs,
      }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        let commits = [...repo.commits];
        if (args.sha !== undefined && args.sha !== repo.defaultBranch) {
          const start = commits.findIndex((commit) => commit.sha === args.sha);
          if (start === -1) throw new GitHubError(404, "Not Found");
          commits = commits.slice(start);
        }
        const { path, author, since, until } = args;
        if (path !== undefined) commits = commits.filter((commit) => commit.files.some((file) => file.filename === path));
        if (author !== undefined) commits = commits.filter((commit) => commit.author === author);
        if (since !== undefined) commits = commits.filter((commit) => commit.date >= since);
        if (until !== undefined) commits = commits.filter((commit) => commit.date <= until);
        return paginate(commits, args).map((commit) => commitShape(repo, commit, false));
      },
    ),

    tool(
      "get_commit",
      "Get one commit with its changed files and diff.",
      z.object({ ...repoArgs, ref: z.string().describe("Commit SHA (full, or at least 7 characters) or branch name") }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        const commit =
          args.ref === repo.defaultBranch
            ? repo.commits[0]
            : args.ref.length >= 7
              ? repo.commits.find((candidate) => candidate.sha.startsWith(args.ref))
              : undefined;
        if (commit === undefined) throw new GitHubError(404, "Not Found");
        return commitShape(repo, commit, true);
      },
    ),

    tool(
      "get_file_contents",
      "Get a file's contents as text, or the listing of a directory. Use an empty path for the repository root.",
      z.object({
        ...repoArgs,
        path: z.string().describe("File or directory path, no leading slash"),
        ref: z.string().optional().describe("Branch name or commit SHA, default the default branch"),
      }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        const ref = args.ref ?? repo.defaultBranch;
        const path = args.path.replace(/^\/+|\/+$/g, "");
        const entry = (entryPath: string, type: "file" | "dir", size: number) => ({
          name: entryPath.split("/").pop() ?? entryPath,
          path: entryPath,
          sha: stableNumber(`${repo.name}:blob:${entryPath}`).toString(16).padStart(40, "0"),
          size,
          url: `${repoUrl(repo)}/contents/${entryPath}?ref=${ref}`,
          html_url: `${repoHtml(repo)}/${type === "file" ? "blob" : "tree"}/${ref}/${entryPath}`,
          download_url: type === "file" ? `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${entryPath}` : null,
          type,
        });
        const file = repo.files.find((candidate) => candidate.path === path);
        if (file !== undefined) {
          return { ...entry(file.path, "file", file.content.length), encoding: "utf-8", content: file.content };
        }
        const prefix = path === "" ? "" : `${path}/`;
        const children = new Map<string, { type: "file" | "dir"; size: number }>();
        for (const candidate of repo.files) {
          if (!candidate.path.startsWith(prefix)) continue;
          const [first, ...rest] = candidate.path.slice(prefix.length).split("/");
          if (first === undefined) continue;
          children.set(`${prefix}${first}`, rest.length === 0 ? { type: "file", size: candidate.content.length } : { type: "dir", size: 0 });
        }
        if (children.size === 0) throw new GitHubError(404, "Not Found");
        return [...children].map(([childPath, child]) => entry(childPath, child.type, child.size));
      },
    ),

    tool(
      "search_code",
      "Search file contents. Every word must appear in the file. Qualifiers: repo:owner/name, org:, user:, path:, filename:, extension:, language:.",
      z.object({ q: z.string().describe("Search words and qualifiers"), ...pageArgs }),
      (args) => {
        const { qualifiers, words } = parseQuery(args.q, ["repo", "org", "user", "path", "filename", "extension", "language"]);
        const items = reposIn(qualifiers).flatMap((repo) =>
          repo.files
            .filter((file) => {
              const text = file.content.toLowerCase();
              return (
                words.every((word) => text.includes(word)) &&
                qualifiers.every(({ key, value }) =>
                  key === "path"
                    ? file.path.startsWith(value)
                    : key === "filename"
                      ? file.path.split("/").pop() === value
                      : key === "extension"
                        ? file.path.endsWith(`.${value.replace(/^\./, "")}`)
                        : key === "language"
                          ? repo.language.toLowerCase() === value.toLowerCase()
                          : true,
                )
              );
            })
            .map((file) => ({
              name: file.path.split("/").pop() ?? file.path,
              path: file.path,
              sha: stableNumber(`${repo.name}:blob:${file.path}`).toString(16).padStart(40, "0"),
              url: `${repoUrl(repo)}/contents/${file.path}`,
              html_url: `${repoHtml(repo)}/blob/${repo.defaultBranch}/${file.path}`,
              repository: repoSummary(repo),
              score: 1,
              text_matches: file.content
                .split("\n")
                .filter((line) => words.some((word) => line.toLowerCase().includes(word)))
                .map((line) => ({ object_type: "FileContent", property: "content", fragment: line })),
            })),
        );
        return { total_count: items.length, incomplete_results: false, items: paginate(items, args) };
      },
    ),

    tool(
      "list_issues",
      "List issues in a repository. Pull requests are included too: an entry that has a `pull_request` field is a pull request, not an issue.",
      z.object({
        ...repoArgs,
        state: z.enum(["open", "closed", "all"]).optional().describe("Default open"),
        labels: z.string().optional().describe("Comma-separated label names; an issue must have all of them"),
        assignee: z.string().optional().describe("A login, `none` for unassigned, or `*` for any"),
        since: z.string().optional().describe("Only issues updated at or after this ISO 8601 time"),
        sort: z.enum(["created", "updated", "comments"]).optional().describe("Default created"),
        direction: z.enum(["asc", "desc"]).optional().describe("Default desc"),
        ...pageArgs,
      }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        const state = args.state ?? "open";
        const wanted = args.labels?.split(",").map((name) => name.trim()).filter((name) => name !== "") ?? [];
        const { assignee, since } = args;
        const issues = repo.issues.filter(
          (issue) =>
            (state === "all" || issue.state === state) &&
            wanted.every((name) => issue.labels.includes(name)) &&
            (assignee === undefined ||
              (assignee === "none" ? issue.assignees.length === 0 : assignee === "*" ? issue.assignees.length > 0 : issue.assignees.includes(assignee))) &&
            (since === undefined || issue.updatedAt >= since),
        );
        const key = (issue: WorldIssue): string | number =>
          args.sort === "updated" ? issue.updatedAt : args.sort === "comments" ? issue.comments.length : issue.createdAt;
        issues.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.number - b.number));
        if ((args.direction ?? "desc") === "desc") issues.reverse();
        return paginate(issues, args).map((issue) => issueShape(repo, world, issue));
      },
    ),

    tool(
      "get_issue",
      "Get one issue, or pull request, with its full body.",
      z.object({ ...repoArgs, issue_number: z.number().int() }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        return issueShape(repo, world, findIssue(repo, args.issue_number));
      },
    ),

    tool(
      "list_issue_comments",
      "List the comments on an issue or pull request, oldest first.",
      z.object({ ...repoArgs, issue_number: z.number().int(), ...pageArgs }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        const issue = findIssue(repo, args.issue_number);
        return paginate(issue.comments, args).map((comment) => ({
          url: `${repoUrl(repo)}/issues/comments/${comment.id}`,
          html_url: `${repoHtml(repo)}/issues/${issue.number}#issuecomment-${comment.id}`,
          issue_url: `${repoUrl(repo)}/issues/${issue.number}`,
          id: comment.id,
          node_id: `IC_${comment.id.toString(36)}`,
          user: user(comment.user),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
          author_association: "MEMBER",
          body: comment.body,
        }));
      },
    ),

    tool(
      "search_issues",
      "Search issues and pull requests, newest first. Every word must appear in the title or body. Qualifiers: repo:owner/name, org:, user:, is:issue, is:pr, is:open, is:closed, is:merged, state:, label:, author:, assignee:, in:title, in:body.",
      z.object({ q: z.string().describe("Search words and qualifiers"), ...pageArgs }),
      (args) => {
        const { qualifiers, words } = parseQuery(args.q, ["repo", "org", "user", "is", "state", "label", "author", "assignee", "in"]);
        const fields = qualifiers.filter(({ key }) => key === "in").map(({ value }) => value);
        const items = reposIn(qualifiers).flatMap((repo) =>
          repo.issues
            .filter((issue) => {
              const text = [
                fields.length === 0 || fields.includes("title") ? issue.title : "",
                fields.length === 0 || fields.includes("body") ? issue.body : "",
              ]
                .join("\n")
                .toLowerCase();
              return (
                words.every((word) => text.includes(word)) &&
                qualifiers.every(({ key, value }) => {
                  if (key === "is" || key === "state") {
                    if (value === "issue") return isIssue(issue);
                    if (value === "pr") return !isIssue(issue);
                    if (value === "merged") return issue.pull?.merged === true;
                    if (value === "open" || value === "closed") return issue.state === value;
                    throw new GitHubError(422, `Validation Failed: ${key}:${value} is not supported here`);
                  }
                  if (key === "label") return issue.labels.includes(value);
                  if (key === "author") return issue.user === value;
                  if (key === "assignee") return issue.assignees.includes(value);
                  return true;
                })
              );
            })
            .map((issue) => ({ issue, shaped: { ...issueShape(repo, world, issue), score: 1 } })),
        );
        items.sort((a, b) => (a.issue.createdAt < b.issue.createdAt ? 1 : -1));
        return { total_count: items.length, incomplete_results: false, items: paginate(items, args).map((item) => item.shaped) };
      },
    ),

    tool(
      "list_pull_requests",
      "List pull requests in a repository, newest first.",
      z.object({
        ...repoArgs,
        state: z.enum(["open", "closed", "all"]).optional().describe("Default open"),
        head: z.string().optional().describe("Filter by head branch, as owner:branch"),
        base: z.string().optional().describe("Filter by base branch name"),
        ...pageArgs,
      }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        const state = args.state ?? "open";
        const { head, base } = args;
        const pulls = repo.issues
          .filter(
            (issue) =>
              issue.pull !== null &&
              (state === "all" || issue.state === state) &&
              (head === undefined || head === `${repo.owner}:${issue.pull.head}`) &&
              (base === undefined || base === issue.pull.base),
          )
          .reverse();
        return paginate(pulls, args).map((issue) => pullShape(repo, world, issue, false));
      },
    ),

    tool(
      "get_pull_request",
      "Get one pull request with its description, merge state and size.",
      z.object({ ...repoArgs, pull_number: z.number().int() }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        return pullShape(repo, world, findIssue(repo, args.pull_number), true);
      },
    ),

    tool(
      "list_pull_request_files",
      "List the files a pull request changes, with patches.",
      z.object({ ...repoArgs, pull_number: z.number().int(), ...pageArgs }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        const issue = findIssue(repo, args.pull_number);
        if (issue.pull === null) throw new GitHubError(404, "Not Found");
        return paginate(issue.pull.files, args).map((file) => changeShape(repo, issue.pull?.head ?? "", file));
      },
    ),

    tool("list_releases", "List releases, newest first, with tag, name and publish date.", z.object({ ...repoArgs, ...pageArgs }), (args) => {
      const repo = findRepo(args.owner, args.repo);
      return paginate(repo.releases, args).map((release) => ({
        url: `${repoUrl(repo)}/releases/${release.id}`,
        assets_url: `${repoUrl(repo)}/releases/${release.id}/assets`,
        html_url: `${repoHtml(repo)}/releases/tag/${release.tag}`,
        id: release.id,
        author: user(release.author),
        node_id: `RE_${release.id.toString(36)}`,
        tag_name: release.tag,
        target_commitish: repo.defaultBranch,
        name: release.name,
        draft: false,
        prerelease: release.prerelease,
        created_at: release.publishedAt,
        published_at: release.publishedAt,
        assets: [],
        tarball_url: `${repoUrl(repo)}/tarball/${release.tag}`,
        zipball_url: `${repoUrl(repo)}/zipball/${release.tag}`,
        body: release.body,
      }));
    }),

    tool(
      "list_workflow_runs",
      "List CI workflow runs, newest first, with status, conclusion, branch and timing.",
      z.object({
        ...repoArgs,
        branch: z.string().optional().describe("Only runs for this branch"),
        event: z.enum(["push", "pull_request"]).optional(),
        status: z.enum(["completed", "success", "failure", "cancelled"]).optional().describe("A status or a conclusion"),
        ...pageArgs,
      }),
      (args) => {
        const repo = findRepo(args.owner, args.repo);
        const { branch, event, status } = args;
        const runs = repo.runs.filter(
          (run) =>
            (branch === undefined || run.branch === branch) &&
            (event === undefined || run.event === event) &&
            (status === undefined || status === "completed" || run.conclusion === status),
        );
        return {
          total_count: runs.length,
          workflow_runs: paginate(runs, args).map((run) => ({
            id: run.id,
            name: "CI",
            node_id: `WFR_${run.id.toString(36)}`,
            head_branch: run.branch,
            head_sha: run.sha,
            path: ".github/workflows/ci.yml",
            display_title: "CI",
            run_number: run.runNumber,
            event: run.event,
            status: "completed",
            conclusion: run.conclusion,
            workflow_id: stableNumber(`${repo.name}:workflow`),
            url: `${repoUrl(repo)}/actions/runs/${run.id}`,
            html_url: `${repoHtml(repo)}/actions/runs/${run.id}`,
            created_at: run.startedAt,
            updated_at: run.updatedAt,
            run_started_at: run.startedAt,
            run_attempt: 1,
            actor: user(run.actor),
            triggering_actor: user(run.actor),
            jobs_url: `${repoUrl(repo)}/actions/runs/${run.id}/jobs`,
            logs_url: `${repoUrl(repo)}/actions/runs/${run.id}/logs`,
          })),
        };
      },
    ),
  ];
}

/** A tool backend over the fixture world. The world is built once and never changes. */
export function githubFixtureBackend(world: World = buildWorld()): ToolBackend {
  const tools = buildTools(world);
  const definitions: ToolDefinition[] = tools.map((entry) => {
    const inputSchema = { ...(z.toJSONSchema(entry.schema) as Record<string, unknown>) };
    // The dialect marker is noise to a model and some providers reject unknown keys.
    delete inputSchema["$schema"];
    return { name: entry.name, description: entry.description, inputSchema };
  });

  return {
    definitions,
    call(name, args) {
      const entry = tools.find((candidate) => candidate.name === name);
      if (entry === undefined) return Promise.reject(new GitHubError(404, `no tool named ${name}`));
      const parsed = entry.schema.safeParse(args);
      if (!parsed.success) {
        return Promise.reject(new GitHubError(422, `Validation Failed: ${z.prettifyError(parsed.error)}`));
      }
      try {
        return Promise.resolve(entry.run(parsed.data as never));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
