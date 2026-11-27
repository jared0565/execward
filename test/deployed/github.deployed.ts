/**
 * The GitHub connector against GitHub itself, through the deployed test Worker
 * (tasks 1.1.2, 1.5.1). Run with `npm run test:deployed`.
 *
 * The credential is the test Worker's secret GITHUB_TOKEN, which only the
 * project owner can create and store. Until it is there, the cases that need
 * it are skipped and the first test says so; they are not passed.
 *
 * The repository read is EXECWARD_TEST_REPO ("owner/name"), or this project's
 * own public repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

const URL_BASE = setting("EXECWARD_TEST_URL", "test-worker-url");
const SECRET = setting("EXECWARD_TEST_SECRET", "test-worker-secret");
const [OWNER = "", REPO = ""] = (process.env.EXECWARD_TEST_REPO ?? "jared0565/execward").split("/");

interface Output {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly report: { readonly callsByTool: Record<string, number>; readonly recordsRead: number; readonly errors: readonly { message: string }[] };
}

async function github<T>(body: unknown): Promise<T> {
  const response = await fetch(`${URL_BASE}/github`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`the test Worker answered ${response.status}`);
  return (await response.json()) as T;
}

async function run(script: string): Promise<{ output: Output; credentialInReply: boolean }> {
  return github({ input: { script, project: "work" } });
}

const { configured } = await github<{ configured: boolean }>({ configured: true });
const where = JSON.stringify({ owner: OWNER, repo: REPO });

describe("the GitHub connector on Cloudflare", { timeout: 60_000 }, () => {
  it("reports whether the test Worker holds a GitHub credential", () => {
    if (!configured) console.warn("GITHUB_TOKEN is not set on the test Worker: the GitHub cases below are SKIPPED, not passed.");
    expect(typeof configured).toBe("boolean");
  });

  it("lets a script find the GitHub tools and read their typed docs, with or without a credential", async () => {
    const { output } = await run(`const found = await search("issue");\nconst docs = await describe("github_list_issues");\nreturn { found, hasTyping: typeof docs.typing === "string" };`);
    expect(output).toMatchObject({ status: "completed", result: { hasTyping: true } });
    expect((output.result as { found: string[] }).found).toContain("github_list_issues");
  });

  it("refuses a tool that is not one of the fifteen, and ends the run", async () => {
    const { output } = await run(`return await tools.github_create_issue({ owner: "x", repo: "y", title: "z" });`);
    // The attempt is counted in the report, and nothing was read: the broker refused it before any request.
    expect(output).toMatchObject({ status: "error", error: { code: "policy_denied", message: "a call was refused: the tool has no policy record" } });
    expect(output.report).toMatchObject({ callsByTool: { github_create_issue: 1 }, recordsRead: 0 });
  });

  it.skipIf(!configured)("reads a repository through a script, and the credential is nowhere in the reply", async () => {
    const { output, credentialInReply } = await run(`const repo = await tools.github_get_repository(${where});\nreturn { name: repo.name, private: repo.private };`);
    expect(output).toMatchObject({ status: "completed", result: { name: REPO } });
    expect(output.report.callsByTool).toEqual({ github_get_repository: 1 });
    expect(credentialInReply).toBe(false);
  });

  it.skipIf(!configured)("combines several reads in one script and returns only the summary", async () => {
    const { output, credentialInReply } = await run(
      `const [branches, pulls, file] = await Promise.all([\n` +
        `  tools.github_list_branches(${where}),\n` +
        `  tools.github_list_pull_requests({ ...${where}, state: "all", per_page: 5 }),\n` +
        `  tools.github_get_file_contents({ ...${where}, path: "package.json" }),\n]);\n` +
        `return { branches: branches.length, pulls: pulls.length, packageName: JSON.parse(file.content).name };`,
    );
    expect(output).toMatchObject({ status: "completed", result: { packageName: "execward" } });
    expect((output.result as { branches: number }).branches).toBeGreaterThan(0);
    expect(credentialInReply).toBe(false);
  });

  it.skipIf(!configured)("gives a script nowhere to find the credential", async () => {
    const { output, credentialInReply } = await run(
      // Everything a script can get hold of: what the tools object is, the docs, a search, and GitHub's own error text.
      `const seen = [];\nfor (const look of [() => JSON.stringify(Object.keys(tools)), () => String(tools.github_get_repository)]) { try { seen.push(look()); } catch (error) { seen.push(String(error)); } }\n` +
        `seen.push(JSON.stringify(await describe("github_get_repository")), JSON.stringify(await search("repository")));\n` +
        `let viaError = "";\ntry { await tools.github_get_repository({ owner: "no-such-owner-execward", repo: "nothing" }); } catch (error) { viaError = String(error) + String(error.stack ?? ""); }\n` +
        `return { seen, viaError };`,
    );
    expect(output.error).toBeUndefined();
    expect(output.status).toBe("completed");
    expect(String((output.result as { viaError: string }).viaError)).toContain("GitHub answered 404");
    expect(JSON.stringify(output)).not.toMatch(/Bearer|authorization/i);
    expect(credentialInReply).toBe(false);
  });

  it.skipIf(!configured)("passes GitHub's own refusal to the script as an error it can catch", async () => {
    const { output } = await run(`try { await tools.github_get_issue({ ...${where}, issue_number: 99999999 }); return "found"; } catch (error) { return String(error.message); }`);
    expect(output.status).toBe("completed");
    // The tool is marked sensitive, so the script is told the status and not GitHub's own words.
    expect(String(output.result)).toContain("the tool failed with status 404");
  });

  it.skipIf(!configured)("holds a credential that GitHub refuses to write with (task 1.1.2)", async () => {
    const { status, readStatus } = await github<{ status: number; readStatus: number }>({ writeProbe: { owner: OWNER, repo: REPO } });
    // The same credential reads the same repository, so the name is right and what follows is about writing.
    expect(readStatus).toBe(200);
    // 403: the credential may not write. 404: it cannot see a write endpoint at all. 201 would mean it can write.
    expect([403, 404]).toContain(status);
  });
});
