import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { principalFromAccess, type AccessContext } from "../src/console/access";
import { ownerConsole, TWO_FACTOR_MAX_AGE_MS, type Principal } from "../src/console/console";
import { memoryControlStore, type ControlState } from "../src/console/control";
import { CONSOLE_HEADER, consoleResponse } from "../src/console/http";
import { consolePage } from "../src/console/page";
import { handle } from "../src/worker";
import { ALLOWED_SECRETS } from "../src/worker/bindings";
import { deployedProblems, type DeployedVersion } from "../src/worker/deployed-check";

const NOW = Date.UTC(2026, 10, 23, 12);
const AUD = "a".repeat(64);
// A made-up address: the real one is a secret and is in no file.
const OWNER = "owner@example.test";
const SETTINGS = { audience: AUD, ownerEmail: OWNER };

function access(identity: unknown, aud: unknown = AUD): AccessContext {
  return { aud, getIdentity: async () => identity };
}
const signedIn = { email: OWNER, iat: NOW / 1000 - 60, user_uuid: "7335d417-61da-459d-899c-0a01c76a2f94" };

describe("who Cloudflare Access says is asking (task 1.6.1, FR-49)", () => {
  it("makes the owner the owner, named by Access's user id and not by email", async () => {
    expect(await principalFromAccess(access(signedIn), SETTINGS)).toEqual({ kind: "owner", id: "owner:7335d417-61da-459d-899c-0a01c76a2f94", twoFactorAt: NOW - 60_000 });
    expect(await principalFromAccess(access({ ...signedIn, email: "  Owner@Example.TEST " }), SETTINGS)).toMatchObject({ kind: "owner" });
  });

  it.each<[string, AccessContext | undefined, { audience: string | undefined; ownerEmail: string | undefined }]>([
    ["a request Access did not authenticate", undefined, SETTINGS],
    ["another person", access({ ...signedIn, email: "someone@example.test" }), SETTINGS],
    ["an address that only contains the owner's", access({ ...signedIn, email: `x${OWNER}` }), SETTINGS],
    ["a sign-in to another Access application", access(signedIn, "b".repeat(64)), SETTINGS],
    ["an audience given as a list", access(signedIn, [AUD]), SETTINGS],
    ["an identity with no email", access({ iat: NOW / 1000 }), SETTINGS],
    ["an identity that is not an object", access("owner@example.test"), SETTINGS],
    ["no identity at all", access(null), SETTINGS],
    ["no way to read the identity", { aud: AUD }, SETTINGS],
    ["a console with no audience set", access(signedIn), { audience: undefined, ownerEmail: OWNER }],
    ["a console with a blank audience", access(signedIn, ""), { audience: " ", ownerEmail: OWNER }],
    ["a console with no owner set", access({ ...signedIn, email: "" }), { audience: AUD, ownerEmail: "" }],
  ])("treats %s as anonymous", async (_label, context, settings) => {
    expect(await principalFromAccess(context, settings)).toEqual({ kind: "anonymous" });
  });

  it("is anonymous when the identity cannot be fetched", async () => {
    const failing: AccessContext = {
      aud: AUD,
      getIdentity: async () => {
        throw new Error("unavailable");
      },
    };
    expect(await principalFromAccess(failing, SETTINGS)).toEqual({ kind: "anonymous" });
  });

  it("never treats a service token as the owner, even one carrying the owner's address", async () => {
    expect(await principalFromAccess(access({ ...signedIn, service_token_status: true }), SETTINGS)).toMatchObject({ kind: "model_client" });
    expect(await principalFromAccess(access({ ...signedIn, service_token_id: "abc.access" }), SETTINGS)).toMatchObject({ kind: "model_client" });
  });

  it("gives a sign-in with no time no age, so the console refuses it", async () => {
    for (const iat of [undefined, "1764000000", Number.NaN, 0, -5]) {
      const principal = await principalFromAccess(access({ ...signedIn, iat }), SETTINGS);
      expect(principal).toMatchObject({ kind: "owner", twoFactorAt: undefined });
    }
  });

  it("falls back to a plain name when Access's user id is not a plain id", async () => {
    expect(await principalFromAccess(access({ ...signedIn, user_uuid: "<script>" }), SETTINGS)).toMatchObject({ id: "owner" });
  });
});

function setup(principal: Principal = { kind: "owner", id: "owner:1", twoFactorAt: NOW - 1000 }) {
  const control = memoryControlStore();
  const store = memoryAuditStore();
  const console_ = ownerConsole({ control, audit: auditLog(store, () => NOW), now: () => NOW });
  const send = (path: string, init?: RequestInit) => consoleResponse(new Request(`https://console.example.test${path}`, init), { console: console_, principal, nonce: () => "testnonce" });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    send("/console/action", {
      method: "POST",
      headers: { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { control, store, send, post };
}

interface Reply {
  readonly state: ControlState & { readonly onboarding: NonNullable<ControlState["onboarding"]> };
  readonly error: string;
  readonly message: string;
}

async function body(response: Response | undefined): Promise<Reply> {
  expect(response).toBeDefined();
  return (await (response as Response).json()) as Reply;
}

describe("the console over HTTP (tasks 1.6.1 to 1.6.5)", () => {
  it("leaves every address that is not the console's alone", async () => {
    const { send } = setup();
    expect(await send("/health")).toBeUndefined();
    expect(await send("/consolex")).toBeUndefined();
    expect(await send("/")).toBeUndefined();
  });

  it("shows the owner the page, with a content policy that loads nothing from elsewhere", async () => {
    const { send } = setup();
    const response = (await send("/console")) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'nonce-testnonce'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain('<script nonce="testnonce">');
  });

  it("writes what it shows as text, never as markup", () => {
    const page = consolePage("n");
    expect(page).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(page).not.toMatch(/<script[^>]+src=|<link|<img|<iframe|on(?:click|load|error)=/i);
  });

  it.each<[string, Principal]>([
    ["nobody signed in", { kind: "anonymous" }],
    ["a model's credential", { kind: "model_client", id: "mcp" }],
    ["the owner without two-factor sign-in", { kind: "owner", id: "o", twoFactorAt: undefined }],
    ["the owner whose sign-in is too old", { kind: "owner", id: "o", twoFactorAt: NOW - TWO_FACTOR_MAX_AGE_MS - 1 }],
  ])("refuses %s the page, the state and every action", async (_label, principal) => {
    const { send, post, control, store } = setup(principal);
    expect(((await send("/console")) as Response).status).toBe(403);
    expect(((await send("/console/state")) as Response).status).toBe(403);
    const refusedPage = await ((await send("/console")) as Response).text();
    expect(refusedPage).not.toContain("<script");
    expect(((await post({ action: "kill" })) as Response).status).toBe(403);
    expect(((await post({ action: "complete_onboarding", profile: "formal" })) as Response).status).toBe(403);
    expect(control.current().version).toBe(0);
    expect(store.entries).toEqual([]);
  });

  it("refuses before reading the request, so a refusal says nothing about what was sent", async () => {
    const { post } = setup({ kind: "anonymous" });
    const response = (await post("this is not JSON")) as Response;
    expect(response.status).toBe(403);
    expect((await body(response)).error).toBe("forbidden");
  });

  it("runs the switches end to end and logs each change", async () => {
    const { send, post, control, store } = setup();
    expect((await body(await send("/console/state"))).state).toMatchObject({ codeMode: false, killed: false, version: 0 });

    // Code Mode cannot go on before onboarding.
    const early = (await post({ action: "code_mode_on" })) as Response;
    expect(early.status).toBe(409);
    expect((await body(early)).message).toMatch(/onboarding/);

    expect((await body(await post({ action: "complete_onboarding", profile: "lightweight" }))).state.onboarding.profile).toBe("lightweight");
    expect((await body(await post({ action: "code_mode_on" }))).state.codeMode).toBe(true);
    expect((await body(await post({ action: "pause_project", project: "acme", reason: "reviewing an exception" }))).state.pausedProjects).toEqual(["acme"]);
    expect((await body(await post({ action: "block_tool", tool: "github.list_issues", reason: "definition changed" }))).state.blockedTools).toEqual(["github.list_issues"]);
    expect((await body(await post({ action: "resume_project", project: "acme", reason: "reviewed" }))).state.pausedProjects).toEqual([]);
    expect((await body(await post({ action: "unblock_tool", tool: "github.list_issues", reason: "reviewed" }))).state.blockedTools).toEqual([]);
    expect((await body(await post({ action: "code_mode_off" }))).state.codeMode).toBe(false);

    expect(control.current().version).toBe(7);
    expect(store.entries.map((entry) => entry.kind)).toEqual(Array(7).fill("console_change"));
  });

  it("stops everything without a reason, and will not start again without one", async () => {
    const { post, control } = setup();
    expect((await body(await post({ action: "kill" }))).state.killed).toBe(true);
    const noReason = (await post({ action: "clear_kill" })) as Response;
    expect(noReason.status).toBe(400);
    expect(control.current().killed).toBe(true);
    expect((await body(await post({ action: "clear_kill", reason: "false alarm, checked the log" }))).state.killed).toBe(false);
  });

  it.each<[string, Record<string, string>]>([
    ["from another site", { origin: "https://evil.example.test" }],
    ["with no origin", { origin: "" }],
    ["without the console's header", { [CONSOLE_HEADER]: "" }],
    ["as a form post", { "content-type": "application/x-www-form-urlencoded" }],
    ["as plain text", { "content-type": "text/plain" }],
  ])("refuses an action sent %s, even from the signed-in owner", async (_label, headers) => {
    const { control, send } = setup();
    const merged: Record<string, string> = { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1", ...headers };
    for (const [name, value] of Object.entries(merged)) if (value === "") delete merged[name];
    const response = (await send("/console/action", { method: "POST", headers: merged, body: JSON.stringify({ action: "kill" }) })) as Response;
    expect(response.status).toBe(403);
    expect(control.current().killed).toBe(false);
  });

  it.each<[string, unknown]>([
    ["text that is not JSON", "kill"],
    ["a list", ["kill"]],
    ["no action", {}],
    ["an action that does not exist", { action: "delete_everything" }],
    ["an action that is not text", { action: 1 }],
    ["a profile that does not exist", { action: "complete_onboarding", profile: "relaxed" }],
    ["a pause with no project", { action: "pause_project", reason: "x" }],
    ["a pause with no reason", { action: "pause_project", project: "acme" }],
    ["a field that is too long", { action: "block_tool", tool: "t".repeat(201), reason: "x" }],
    ["a request that is too long", { action: "kill", padding: "p".repeat(5000) }],
  ])("refuses %s and changes nothing", async (_label, sent) => {
    const { post, control } = setup();
    expect(((await post(sent)) as Response).status).toBe(400);
    expect(control.current().version).toBe(0);
  });

  it("does not accept a change by GET, or the page by POST", async () => {
    const { send, control } = setup();
    expect(((await send("/console/action?action=kill")) as Response).status).toBe(404);
    expect(((await send("/console", { method: "POST" })) as Response).status).toBe(404);
    expect(((await send("/console/nothing")) as Response).status).toBe(404);
    expect(control.current().killed).toBe(false);
  });

  it("does not show its own failures to the browser", async () => {
    const broken = {
      state: async () => {
        throw new Error("D1_ERROR: no such table: control_state at 10.0.0.7");
      },
    } as never;
    const response = (await consoleResponse(new Request("https://c.example.test/console/state"), { console: broken, principal: { kind: "anonymous" }, nonce: () => "n" })) as Response;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/D1_ERROR|control_state|10\.0\.0\.7/);
  });
});

describe("the Worker in front of the console", () => {
  // A database that fails the test if it is touched: a refusal must come before any read.
  const untouchable = {
    prepare() {
      throw new Error("the database was read for a request that should have been refused");
    },
  };
  const env = (extra: Record<string, unknown> = {}) => ({ LOADER: {}, DB: untouchable, BACKUPS: {}, ...extra }) as never;

  it("refuses the console when Access is not set up, whoever asks", async () => {
    for (const path of ["/console", "/console/state"]) {
      expect((await handle(new Request(`https://w.example.test${path}`), env(), access(signedIn), () => NOW)).status).toBe(403);
    }
  });

  it("refuses the console to a request Access did not authenticate, and to another person", async () => {
    const configured = env({ ACCESS_AUD: AUD, OWNER_EMAIL: OWNER });
    expect((await handle(new Request("https://w.example.test/console"), configured, undefined, () => NOW)).status).toBe(403);
    expect((await handle(new Request("https://w.example.test/console"), configured, access({ ...signedIn, email: "other@example.test" }), () => NOW)).status).toBe(403);
  });

  it("ignores anything a request says about who sent it", async () => {
    const configured = env({ ACCESS_AUD: AUD, OWNER_EMAIL: OWNER });
    const forged = new Request("https://w.example.test/console/state", {
      headers: { "cf-access-authenticated-user-email": OWNER, "cf-access-jwt-assertion": "forged", cookie: "CF_Authorization=forged", authorization: "Bearer forged" },
    });
    expect((await handle(forged, configured, undefined, () => NOW)).status).toBe(403);
  });

  it("still answers the health check without reading who is asking", async () => {
    const neverAsked: AccessContext = {
      aud: AUD,
      getIdentity: async () => {
        throw new Error("the identity was read for a health check");
      },
    };
    expect((await handle(new Request("https://w.example.test/health"), env(), neverAsked, () => NOW)).status).toBe(200);
  });
});

describe("the secrets the deployed Worker may hold", () => {
  const live: DeployedVersion = { bindings: [], compatibilityDate: undefined, secrets: [] };
  const secretProblems = (version: DeployedVersion) => deployedProblems(version).filter((problem) => /secret|not on the allowlist/.test(problem));

  it("are the two that say who the owner is, and no credential", () => {
    expect(ALLOWED_SECRETS).toEqual(["ACCESS_AUD", "OWNER_EMAIL"]);
  });

  it("allows those, listed either way, and still refuses any other", () => {
    expect(secretProblems({ ...live, secrets: ["ACCESS_AUD", "OWNER_EMAIL"] })).toEqual([]);
    expect(secretProblems({ ...live, bindings: [{ type: "secret_text", name: "OWNER_EMAIL" }] })).toEqual([]);
    expect(secretProblems({ ...live, secrets: ["GITHUB_TOKEN"] })).toHaveLength(1);
    expect(secretProblems({ ...live, bindings: [{ type: "secret_text", name: "GITHUB_TOKEN" }] })).toHaveLength(1);
    // A binding of another kind cannot borrow an allowed secret's name.
    expect(secretProblems({ ...live, bindings: [{ type: "kv_namespace", name: "OWNER_EMAIL" }] })).toHaveLength(1);
  });
});
