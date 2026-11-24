/**
 * Shows that the GitHub credential cannot write (tasks 1.1.2 and 2.1.10).
 *
 * It tries the least visible write there is: a file object in one repository
 * that nothing points to. GitHub must refuse it with 403. Only the status is
 * kept; nothing of GitHub's reply is returned.
 *
 * The owner asks for it from the console. Nothing else can.
 */

export type WriteCheckOutcome =
  /** GitHub answered 403: the credential cannot write. The result wanted. */
  | "refused"
  /** GitHub created the object: the credential CAN write. Its permissions are wrong. */
  | "accepted"
  /** There is no credential to try with. */
  | "no_credential"
  /** Anything else: the repository is not one the credential covers, GitHub was not reached, and the like. */
  | "inconclusive";

export interface WriteCheckResult {
  readonly outcome: WriteCheckOutcome;
  /** GitHub's status, when it answered. */
  readonly status?: number;
}

export interface WriteCheckDeps {
  readonly token: () => string | undefined | Promise<string | undefined>;
  /** The guarded fetch: it goes to api.github.com and nowhere else. */
  readonly fetch: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual" }) => Promise<Response>;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Splits "owner/repo", or returns `undefined` when it is not that. */
export function repositoryName(text: string): { readonly owner: string; readonly repo: string } | undefined {
  const [owner, repo, ...rest] = text.split("/");
  if (owner === undefined || repo === undefined || rest.length > 0) return undefined;
  if (!NAME.test(owner) || !NAME.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") return undefined;
  return { owner, repo };
}

export async function githubWriteCheck(deps: WriteCheckDeps, owner: string, repo: string): Promise<WriteCheckResult> {
  if (repositoryName(`${owner}/${repo}`) === undefined) return { outcome: "inconclusive" };
  let token: string | undefined;
  try {
    token = await deps.token();
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || token === "") return { outcome: "no_credential" };
  let status: number;
  try {
    const response = await deps.fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      redirect: "manual",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "execward", "content-type": "application/json" },
      body: JSON.stringify({ content: "execward write check", encoding: "utf-8" }),
    });
    status = response.status;
  } catch {
    // The error's text can hold the request. It is not passed on.
    return { outcome: "inconclusive" };
  }
  if (status === 403) return { outcome: "refused", status };
  if (status === 201) return { outcome: "accepted", status };
  return { outcome: "inconclusive", status };
}
