import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { githubWriteCheck, repositoryName, type WriteCheckResult } from "../src/connectors/github-write-check";
import { ownerConsole, type Principal } from "../src/console/console";
import { memoryControlStore } from "../src/console/control";
import { CONSOLE_HEADER, consoleResponse } from "../src/console/http";

const NOW = Date.UTC(2026, 10, 24, 13);
const TOKEN = "installation-token-for-tests";

function github(status: number | "down", body = "{}") {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string; redirect: string } }[] = [];
  return {
    calls,
    fetch: async (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual" }) => {
      calls.push({ url, init });
      if (status === "down") throw new Error(`could not send with ${TOKEN}`);
      return new Response(status === 204 ? null : body, { status });
    },
  };
}

describe("the check that the GitHub credential cannot write (tasks 1.1.2, 2.1.10)", () => {
  it("tries to create one file object nothing points to, at GitHub's own address, following no redirect", async () => {
    const api = github(403);
    expect(await githubWriteCheck({ token: () => TOKEN, fetch: api.fetch }, "acme", "tools")).toEqual({ outcome: "refused", status: 403 });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toBe("https://api.github.com/repos/acme/tools/git/blobs");
    expect(api.calls[0]?.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(api.calls[0]?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each<[number | "down", WriteCheckResult]>([
    [201, { outcome: "accepted", status: 201 }],
    [404, { outcome: "inconclusive", status: 404 }],
    [401, { outcome: "inconclusive", status: 401 }],
    [302, { outcome: "inconclusive", status: 302 }],
    ["down", { outcome: "inconclusive" }],
  ])("reads GitHub's answer %s as %j, and only a 403 as refused", async (status, expected) => {
    const api = github(status);
    expect(await githubWriteCheck({ token: () => TOKEN, fetch: api.fetch }, "acme", "tools")).toEqual(expected);
  });

  it("returns nothing of GitHub's reply or of the credential", async () => {
    const api = github(403, JSON.stringify({ message: `token ${TOKEN} may not write` }));
    expect(JSON.stringify(await githubWriteCheck({ token: () => TOKEN, fetch: api.fetch }, "acme", "tools"))).not.toContain(TOKEN);
  });

  it.each<[string, () => string | undefined | Promise<string | undefined>]>([
    ["there is none", () => undefined],
    ["it is blank", () => ""],
    ["it cannot be had", async () => Promise.reject(new Error("no"))],
  ])("asks GitHub nothing when the credential is missing: %s", async (_label, token) => {
    const api = github(403);
    expect(await githubWriteCheck({ token, fetch: api.fetch }, "acme", "tools")).toEqual({ outcome: "no_credential" });
    expect(api.calls).toHaveLength(0);
  });

  it.each(["acme/tools/extra", "acme", "/tools", "acme/", "../x", "acme/..", "a b/c", "acme/tools?x=1", "acme/tools#x", "acme%2Fx/tools"])("does not take %j as a repository", (text) => {
    expect(repositoryName(text)).toBeUndefined();
  });

  it("takes an ordinary name", () => {
    expect(repositoryName("jared0565/exec-ward_1.x")).toEqual({ owner: "jared0565", repo: "exec-ward_1.x" });
  });
});

describe("asking for the write check from the console", () => {
  const OWNER: Principal = { kind: "owner", id: "owner:1", twoFactorAt: NOW - 1000 };

  function setup(principal: Principal = OWNER, result: WriteCheckResult = { outcome: "refused", status: 403 }, connected = true) {
    const audit = auditLog(memoryAuditStore(), () => NOW);
    const console_ = ownerConsole({ control: memoryControlStore(), audit, now: () => NOW });
    const asked: string[] = [];
    const check = async (owner: string, repo: string): Promise<WriteCheckResult> => {
      asked.push(`${owner}/${repo}`);
      return result;
    };
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      consoleResponse(
        new Request("https://console.example.test/console/action", {
          method: "POST",
          headers: { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1", ...headers },
          body: JSON.stringify(body),
        }),
        { console: console_, principal, nonce: () => "n", ...(connected ? { githubWriteCheck: check } : {}) },
      ) as Promise<Response>;
    return { post, asked };
  }

  it("runs it for the owner and says plainly what GitHub answered", async () => {
    const { post, asked } = setup();
    const response = await post({ action: "github_write_check", repository: "acme/tools" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ writeCheck: { outcome: "refused", status: 403 }, message: "GitHub refused the write. The credential can only read." });
    expect(asked).toEqual(["acme/tools"]);
  });

  it("warns loudly when GitHub accepted the write", async () => {
    const { post } = setup(OWNER, { outcome: "accepted", status: 201 });
    expect(((await (await post({ action: "github_write_check", repository: "acme/tools" })).json()) as { message: string }).message).toMatch(/^WARNING: GitHub ACCEPTED/);
  });

  it.each<[string, Principal]>([
    ["someone not signed in", { kind: "anonymous" }],
    ["a model client", { kind: "model_client", id: "client:1" }],
    ["the owner without a recent second factor", { kind: "owner", id: "owner:1", twoFactorAt: NOW - 13 * 3_600_000 }],
  ])("never runs it for %s", async (_label, principal) => {
    const { post, asked } = setup(principal);
    expect((await post({ action: "github_write_check", repository: "acme/tools" })).status).toBeGreaterThanOrEqual(401);
    expect(asked).toEqual([]);
  });

  it("never runs it for a request that did not come from the console's own page", async () => {
    const { post, asked } = setup();
    expect((await post({ action: "github_write_check", repository: "acme/tools" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(asked).toEqual([]);
  });

  it("refuses a repository that is not written as owner/name, without asking GitHub", async () => {
    const { post, asked } = setup();
    expect((await post({ action: "github_write_check", repository: "acme/tools/../../user" })).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it("says GitHub is not connected when it is not", async () => {
    const { post } = setup(OWNER, undefined, false);
    expect((await post({ action: "github_write_check", repository: "acme/tools" })).status).toBe(409);
  });
});
