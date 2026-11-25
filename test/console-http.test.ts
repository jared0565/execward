import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { principalFromAccess, type AccessContext } from "../src/console/access";
import { ownerConsole, TWO_FACTOR_MAX_AGE_MS, type Principal } from "../src/console/console";
import { memoryControlStore, type ControlState } from "../src/console/control";
import { escalationQueue, memoryEscalationStore } from "../src/console/escalations";
import { CONSOLE_HEADER, consoleResponse } from "../src/console/http";
import { ALERT_SENDER, bindingMailer, CONSOLE_URL, TEST_EMAIL } from "../src/console/mailer";
import { notifier, type Email } from "../src/console/notify";
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
  const audit = auditLog(store, () => NOW);
  const console_ = ownerConsole({ control, audit, now: () => NOW });
  let ids = 0;
  const queue = escalationQueue({ store: memoryEscalationStore(), control, audit, now: () => NOW, newId: () => `item-${++ids}` });
  const send = (path: string, init?: RequestInit) => consoleResponse(new Request(`https://console.example.test${path}`, init), { console: console_, queue, principal, nonce: () => "testnonce" });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    send("/console/action", {
      method: "POST",
      headers: { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { control, store, send, post, queue };
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

describe("the escalation queue in the console (tasks 1.6.6, 1.6.9)", () => {
  const SECRET_TEXT = "client secret: the Henderson contract is worth 4m";

  it("shows the owner what is waiting, with the options and the recommendation, and not the run's contents", async () => {
    const { send, queue } = setup();
    await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1", error: { code: "sandbox_fault", message: SECRET_TEXT } });
    const response = (await send("/console/queue")) as Response;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("Henderson");
    const listed = JSON.parse(text) as { items: Record<string, unknown>[]; proposals: unknown[] };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: "item-1", trigger: "security_exception", project: "acme", urgent: true, errorCode: "sandbox_fault" });
    expect(Object.keys(listed.items[0] as object)).not.toContain("report");
    expect(Object.keys(listed.items[0] as object)).not.toContain("error");
    expect((listed.items[0] as { options: unknown[] }).options.length).toBeGreaterThan(1);
    expect(listed.proposals).toEqual([]);
  });

  it("records the owner's choice, and the item leaves the queue", async () => {
    const { send, post, queue, control } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1" });
    // Raising a security exception pauses the project by itself.
    expect(control.current().pausedProjects).toEqual(["acme"]);
    // "False positive" lifts a protection, so it needs a written reason.
    expect(((await post({ action: "resolve", id: item.id, option: "false_positive" })) as Response).status).toBe(409);
    expect(control.current().pausedProjects).toEqual(["acme"]);
    const reply = (await post({ action: "resolve", id: item.id, option: "false_positive", reason: "reviewed the log" })) as Response;
    expect(reply.status).toBe(200);
    const replied = (await reply.json()) as { resolved: unknown; state: { pausedProjects: string[] } };
    expect(replied.resolved).toEqual({ id: "item-1", status: "resolved" });
    expect(replied.state.pausedProjects).toEqual([]);
    const after = (await ((await send("/console/queue")) as Response).json()) as { items: unknown[] };
    expect(after.items).toEqual([]);
  });

  it("keeps an item in the queue, and the project paused, when the owner chooses to keep it paused", async () => {
    const { send, post, queue, control } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1" });
    const reply = (await post({ action: "resolve", id: item.id, option: "keep_paused" })) as Response;
    expect(((await reply.json()) as { resolved: unknown }).resolved).toEqual({ id: "item-1", status: "open" });
    expect(control.current().pausedProjects).toEqual(["acme"]);
    const after = (await ((await send("/console/queue")) as Response).json()) as { items: { acknowledgedAt?: number }[] };
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.acknowledgedAt).toBe(NOW);
  });

  it.each<[string, Record<string, unknown>, number]>([
    ["an item that does not exist", { action: "resolve", id: "item-99", option: "x" }, 409],
    ["an option the item does not have", { action: "resolve", id: "item-1", option: "do_anything" }, 409],
    ["no item named", { action: "resolve", option: "x" }, 400],
    ["no option named", { action: "resolve", id: "item-1" }, 400],
  ])("refuses a choice on %s", async (_label, sent, status) => {
    const { post, queue, send } = setup();
    await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1" });
    expect(((await post(sent)) as Response).status).toBe(status);
    expect(((await ((await send("/console/queue")) as Response).json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("refuses the queue and any choice to anyone but the signed-in owner", async () => {
    for (const principal of [{ kind: "anonymous" }, { kind: "model_client", id: "mcp" }, { kind: "owner", id: "o", twoFactorAt: undefined }] as Principal[]) {
      const { send, post, queue } = setup(principal);
      const item = await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1" });
      expect(((await send("/console/queue")) as Response).status).toBe(403);
      expect(((await post({ action: "resolve", id: item.id, option: item.options[0]?.id, reason: "x" })) as Response).status).toBe(403);
    }
  });

  it("draws each item on the page as text", () => {
    const page = consolePage("n");
    expect(page).toContain("Waiting for you");
    expect(page).toContain("textContent");
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
});

describe("sending email (task 1.6.7)", () => {
  const HOUR = 60 * 60 * 1000;

  it("hands an email to the binding from the one sender to the one recipient, as plain text", async () => {
    const sent: unknown[] = [];
    const mailer = bindingMailer({ send: async (message: unknown) => void sent.push(message) }, "  owner@example.test ");
    await mailer?.send({ subject: "S", body: "B" });
    expect(sent).toEqual([{ from: ALERT_SENDER, to: "owner@example.test", subject: "S", text: "B" }]);
    expect(ALERT_SENDER).toBe("alerts@notify.execward.com");
  });

  it.each<[string, unknown, string | undefined]>([
    ["no binding", undefined, "owner@example.test"],
    ["a binding that cannot send", {}, "owner@example.test"],
    ["no recipient", { send: async () => undefined }, undefined],
    ["a blank recipient", { send: async () => undefined }, "  "],
    ["two recipients", { send: async () => undefined }, "a@example.test, b@example.test"],
    ["a recipient with a header smuggled in", { send: async () => undefined }, "a@example.test\nBcc: b@example.test"],
    ["a recipient with a display name", { send: async () => undefined }, "Owner <a@example.test>"],
    ["something that is not an address", { send: async () => undefined }, "owner"],
  ])("is not set up with %s", (_label, binding, to) => {
    expect(bindingMailer(binding, to)).toBeUndefined();
  });

  it("sends a test email that says nothing and links only to the console", () => {
    expect(TEST_EMAIL.body).toContain(`${CONSOLE_URL}/console`);
    expect([...TEST_EMAIL.body.matchAll(/https?:\/\/[^\s]+/g)].map((match) => match[0])).toEqual(["https://console.execward.com/console"]);
  });

  it("lets the signed-in owner send it from the console, and nobody else", async () => {
    const sent: Email[] = [];
    const mailer = { send: async (email: Email) => void sent.push(email) };
    const make = (principal: Principal) => {
      const control = memoryControlStore();
      const console_ = ownerConsole({ control, audit: auditLog(memoryAuditStore(), () => NOW), now: () => NOW });
      return consoleResponse(
        new Request("https://console.example.test/console/action", {
          method: "POST",
          headers: { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1" },
          body: JSON.stringify({ action: "test_email" }),
        }),
        { console: console_, mailer, principal, nonce: () => "n" },
      );
    };
    expect(((await make({ kind: "anonymous" })) as Response).status).toBe(403);
    expect(((await make({ kind: "model_client", id: "mcp" })) as Response).status).toBe(403);
    expect(sent).toEqual([]);
    expect(((await make({ kind: "owner", id: "o", twoFactorAt: NOW - 1000 })) as Response).status).toBe(200);
    expect(sent).toEqual([TEST_EMAIL]);
  });

  it("says so when email is not set up, and when a send fails, without the reason", async () => {
    const { post } = setup();
    const none = (await post({ action: "test_email" })) as Response;
    expect(none.status).toBe(409);
    const control = memoryControlStore();
    const console_ = ownerConsole({ control, audit: auditLog(memoryAuditStore(), () => NOW), now: () => NOW });
    const failing = {
      send: async () => {
        throw new Error("550 mailbox owner@example.test rejected by mx.example.test");
      },
    };
    const response = (await consoleResponse(
      new Request("https://console.example.test/console/action", {
        method: "POST",
        headers: { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1" },
        body: JSON.stringify({ action: "test_email" }),
      }),
      { console: console_, mailer: failing, principal: { kind: "owner", id: "o", twoFactorAt: NOW - 1000 }, nonce: () => "n" },
    )) as Response;
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/550|mailbox|example\.test/);
  });

  it("reminds about an urgent item once an hour on a timer that remembers nothing", async () => {
    const { queue } = setup();
    const item = await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1" });
    const TICK = 5 * 60 * 1000;
    let sent = 0;
    // A new notifier every run, as on a Worker: nothing is carried from one run to the next.
    const times: number[] = [];
    // The timer's runs do not line up with the moment the item was raised.
    for (let now = item.createdAt + 2 * 60 * 1000; now <= item.createdAt + 3 * HOUR + TICK; now += TICK) {
      const fresh = notifier({ mailer: { send: async () => void (sent += 1) }, baseUrl: CONSOLE_URL, tickMs: TICK });
      const before = sent;
      await fresh.remind([item], now);
      if (sent > before) times.push(Math.round((now - item.createdAt) / 60000));
    }
    // Minutes after it was raised: within five minutes, then once an hour.
    expect(times).toEqual([2, 62, 122, 182]);
    expect(sent).toBe(4);
  });

  it("does not write again between the first email and the first hour, or about an item that is not urgent", async () => {
    const { queue } = setup();
    const urgent = await queue.raise({ trigger: "security_exception", project: "acme", runId: "run-1" });
    const calm = await queue.raise({ trigger: "definition_changed", project: "acme", runId: "run-2", context: { toolPath: "github.list_issues" } });
    let sent = 0;
    const fresh = () => notifier({ mailer: { send: async () => void (sent += 1) }, baseUrl: CONSOLE_URL, tickMs: 5 * 60 * 1000 });
    await fresh().remind([urgent, calm], urgent.createdAt + 55 * 60 * 1000);
    await fresh().remind([calm], calm.createdAt + 24 * HOUR);
    expect(sent).toBe(0);
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

  it("are the three that say who the owner is and which sign-in a request came through, the GitHub App, and verification's key", () => {
    expect(ALLOWED_SECRETS).toEqual(["ACCESS_AUD", "MCP_ACCESS_AUD", "OWNER_EMAIL", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "VERIFY_OPENAI_API_KEY"]);
  });

  it("allows those, listed either way, and still refuses any other", () => {
    expect(secretProblems({ ...live, secrets: ["ACCESS_AUD", "MCP_ACCESS_AUD", "OWNER_EMAIL"] })).toEqual([]);
    expect(secretProblems({ ...live, bindings: [{ type: "secret_text", name: "OWNER_EMAIL" }] })).toEqual([]);
    expect(secretProblems({ ...live, secrets: ["GITHUB_TOKEN"] })).toHaveLength(1);
    expect(secretProblems({ ...live, bindings: [{ type: "secret_text", name: "GITHUB_TOKEN" }] })).toHaveLength(1);
    // A binding of another kind cannot borrow an allowed secret's name.
    expect(secretProblems({ ...live, bindings: [{ type: "kv_namespace", name: "OWNER_EMAIL" }] })).toHaveLength(1);
  });
});
