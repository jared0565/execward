import { describe, expect, it } from "vitest";
import { auditLog, memoryAuditStore } from "../src/audit/log";
import { exposureFor, type ClientChoice, type ProjectRecord } from "../src/broker/exposure";
import { clientChoices, type ClientChoiceStore } from "../src/console/client-choice";
import { ownerConsole, TWO_FACTOR_MAX_AGE_MS, type Principal } from "../src/console/console";
import { memoryControlStore } from "../src/console/control";
import { CONSOLE_HEADER, consoleResponse } from "../src/console/http";

const NOW = Date.UTC(2026, 10, 26, 12);
const OWNER: Principal = { kind: "owner", id: "owner:1", twoFactorAt: NOW - 1000 };

/** Project records in memory, in the shape the database store has. */
function memoryStore(initial: readonly ProjectRecord[]): ClientChoiceStore & { writes: number } {
  const byName = new Map(initial.map((record) => [record.project, record]));
  const store = {
    writes: 0,
    get: async (project: string) => byName.get(project),
    list: async () => [...byName.values()].sort((a, b) => a.project.localeCompare(b.project)),
    setChoice: async (project: string, choice: ClientChoice | undefined) => {
      const found = byName.get(project);
      if (found === undefined) return false;
      store.writes++;
      byName.set(project, { project, dataClass: found.dataClass, ...(choice === undefined ? {} : { clientChoice: choice }) });
      return true;
    },
  };
  return store;
}

function setup(principal: Principal = OWNER, failingAudit = false) {
  const store = memoryStore([
    { project: "acme", dataClass: "confidential" },
    { project: "work", dataClass: "internal" },
  ]);
  const entries = memoryAuditStore();
  const audit = failingAudit ? { ...auditLog(entries, () => NOW), record: async () => Promise.reject(new Error("log down")) } : auditLog(entries, () => NOW);
  const choices = clientChoices({ store, audit: audit as never, now: () => NOW });
  const console_ = ownerConsole({ control: memoryControlStore(), audit: auditLog(memoryAuditStore(), () => NOW), now: () => NOW });
  const send = (path: string, init?: RequestInit) => consoleResponse(new Request(`https://console.example.test${path}`, init), { console: console_, clientChoices: choices, principal, nonce: () => "n" });
  const post = (body: unknown) =>
    send("/console/action", { method: "POST", headers: { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1" }, body: JSON.stringify(body) }) as Promise<Response>;
  const logged = () => entries.entries.map((entry) => ({ kind: entry.kind, project: entry.project, ...(JSON.parse(entry.content ?? "{}") as Record<string, unknown>) }));
  return { store, choices, send, post, logged, principal };
}

describe("recording what a project's client has asked for (task G.13)", () => {
  it("records no AI use for a project, with who asked, and logs what it was before and after", async () => {
    const { choices, store, logged } = setup();
    const after = await choices.set(OWNER, "acme", { aiUse: "off" }, "  Asked by email on 2026-11-26  ");
    expect(after).toEqual({ project: "acme", dataClass: "confidential", clientChoice: { aiUse: "off" } });
    expect(await store.get("acme")).toEqual(after);
    expect(logged()).toEqual([{ kind: "console_change", project: "acme", action: "set_client_choice", by: "owner:1", reason: "Asked by email on 2026-11-26", before: null, after: { aiUse: "off" } }]);
  });

  it("makes the recorded limit the one a run then gets", async () => {
    const { choices, store } = setup();
    expect((await exposureFor(store, "acme", "anthropic_api_commercial")).allowed).toBe("confidential");
    await choices.set(OWNER, "acme", { aiUse: "on", limit: "public" }, "asked on a call, 2026-11-26");
    expect(await exposureFor(store, "acme", "anthropic_api_commercial")).toMatchObject({ projectClass: "confidential", clientLimit: "public", allowed: "public" });
    // Cleared again: the project's own class stands.
    await choices.set(OWNER, "acme", undefined, "client withdrew the limit, 2026-11-27");
    expect((await exposureFor(store, "acme", "anthropic_api_commercial")).allowed).toBe("confidential");
  });

  it("needs a reason, a project with a record, and a choice it knows; otherwise nothing is written or logged", async () => {
    const { choices, store, logged } = setup();
    await expect(choices.set(OWNER, "acme", { aiUse: "off" }, "   ")).rejects.toThrow("a reason is required");
    await expect(choices.set(OWNER, "never-set-up", { aiUse: "off" }, "asked")).rejects.toThrow("that project has no record here");
    await expect(choices.set(OWNER, "acme", { aiUse: "on", limit: "secret" as never }, "asked")).rejects.toThrow('"secret" is not a data class');
    await expect(choices.set(OWNER, "acme", { aiUse: "sometimes" as never }, "asked")).rejects.toThrow("is not a choice for AI use");
    expect(store.writes).toBe(0);
    expect(logged()).toEqual([]);
  });

  it("does not write or log a choice that is already the one on record", async () => {
    const { choices, store, logged } = setup();
    await choices.set(OWNER, "acme", { aiUse: "off" }, "asked");
    await choices.set(OWNER, "acme", { aiUse: "off" }, "asked again");
    await choices.set(OWNER, "work", undefined, "nothing was set");
    expect(store.writes).toBe(1);
    expect(logged()).toHaveLength(1);
  });

  it("keeps the choice when the audit log cannot be written, and says so", async () => {
    const { choices, store } = setup(OWNER, true);
    await expect(choices.set(OWNER, "acme", { aiUse: "off" }, "asked")).rejects.toThrow("the choice was recorded but could not be written to the audit log");
    expect((await store.get("acme"))?.clientChoice).toEqual({ aiUse: "off" });
  });

  it("does not lift a restriction when the audit log cannot be written: nothing changes", async () => {
    // Set while the log works, then try to relax it while the log is down.
    const { choices, store } = setup();
    await choices.set(OWNER, "acme", { aiUse: "off" }, "asked");
    await choices.set(OWNER, "work", { aiUse: "on", limit: "public" }, "asked");
    const down = clientChoices({ store, audit: { record: async () => Promise.reject(new Error("log down")) } as never, now: () => NOW });
    const refusal = "nothing was changed: the audit log could not be written, and a client's restriction is not lifted without a record";
    await expect(down.set(OWNER, "acme", undefined, "client changed their mind")).rejects.toThrow(refusal);
    await expect(down.set(OWNER, "acme", { aiUse: "on", limit: "internal" }, "client changed their mind")).rejects.toThrow(refusal);
    await expect(down.set(OWNER, "work", { aiUse: "on", limit: "internal" }, "client changed their mind")).rejects.toThrow(refusal);
    expect((await store.get("acme"))?.clientChoice).toEqual({ aiUse: "off" });
    expect((await store.get("work"))?.clientChoice).toEqual({ aiUse: "on", limit: "public" });
    // A tighter choice still takes effect with the log down.
    await expect(down.set(OWNER, "work", { aiUse: "off" }, "asked")).rejects.toThrow("the choice was recorded but could not be written to the audit log");
    expect((await store.get("work"))?.clientChoice).toEqual({ aiUse: "off" });
  });

  it.each<[string, Principal]>([
    ["nobody signed in", { kind: "anonymous" }],
    ["a model's credential", { kind: "model_client", id: "mcp" }],
    ["the owner without two-factor sign-in", { kind: "owner", id: "o", twoFactorAt: undefined }],
    ["the owner whose sign-in is too old", { kind: "owner", id: "o", twoFactorAt: NOW - TWO_FACTOR_MAX_AGE_MS - 1 }],
  ])("refuses %s the list and any change, directly and over HTTP", async (_label, principal) => {
    const { choices, store, send, post, logged } = setup(principal);
    await expect(choices.list(principal)).rejects.toThrow();
    await expect(choices.set(principal, "acme", { aiUse: "off" }, "asked")).rejects.toThrow();
    expect(((await send("/console/projects")) as Response).status).toBe(403);
    expect((await post({ action: "set_client_choice", project: "acme", aiUse: "off", reason: "asked" })).status).toBe(403);
    expect(store.writes).toBe(0);
    expect(logged()).toEqual([]);
  });
});

describe("client choices in the console over HTTP", () => {
  interface Reply {
    readonly projects: readonly ProjectRecord[];
    readonly error: string;
    readonly message: string;
  }
  const read = async (response: Response | undefined): Promise<Reply> => (await (response as Response).json()) as Reply;

  it("lists every project with its class and its client's choice", async () => {
    const { send, post } = setup();
    expect((await read(await send("/console/projects"))).projects).toEqual([
      { project: "acme", dataClass: "confidential" },
      { project: "work", dataClass: "internal" },
    ]);
    const reply = await read(await post({ action: "set_client_choice", project: "acme", aiUse: "off", limit: "internal", reason: "asked by email, 2026-11-26" }));
    expect(reply.projects[0]).toEqual({ project: "acme", dataClass: "confidential", clientChoice: { aiUse: "off", limit: "internal" } });
  });

  it("takes AI use on with no limit as no choice, and clears the record", async () => {
    const { post, store } = setup();
    await post({ action: "set_client_choice", project: "acme", aiUse: "off", reason: "asked" });
    const response = await post({ action: "set_client_choice", project: "acme", aiUse: "on", limit: "", reason: "client changed their mind, 2026-11-27" });
    expect(response.status).toBe(200);
    expect(await store.get("acme")).toEqual({ project: "acme", dataClass: "confidential" });
  });

  it("refuses a request that is not in the form it reads, and a project with no record, and changes nothing", async () => {
    const { post, store } = setup();
    const bad: [Record<string, unknown>, number, RegExp][] = [
      [{ action: "set_client_choice", project: "acme", aiUse: "maybe", reason: "asked" }, 400, /"aiUse" must be "on" or "off"/],
      [{ action: "set_client_choice", project: "acme", aiUse: "off", limit: "secret", reason: "asked" }, 400, /"limit" must be a data class/],
      [{ action: "set_client_choice", project: "acme", aiUse: "off" }, 400, /"reason" must be text/],
      [{ action: "set_client_choice", aiUse: "off", reason: "asked" }, 400, /"project" must be text/],
      [{ action: "set_client_choice", project: "never-set-up", aiUse: "off", reason: "asked" }, 409, /has no record here/],
    ];
    for (const [sent, status, message] of bad) {
      const response = await post(sent);
      expect(response.status, JSON.stringify(sent)).toBe(status);
      expect((await read(response)).message).toMatch(message);
    }
    expect(store.writes).toBe(0);
    // The name that was typed is not repeated in the refusal.
    expect(JSON.stringify(await read(await post({ action: "set_client_choice", project: "never-set-up", aiUse: "off", reason: "asked" })))).not.toContain("never-set-up");
  });

  it("has no projects address, and refuses the action, where client choices are not set up", async () => {
    const console_ = ownerConsole({ control: memoryControlStore(), audit: auditLog(memoryAuditStore(), () => NOW), now: () => NOW });
    const deps = { console: console_, principal: OWNER, nonce: () => "n" };
    expect(((await consoleResponse(new Request("https://console.example.test/console/projects"), deps)) as Response).status).toBe(404);
    const response = (await consoleResponse(
      new Request("https://console.example.test/console/action", { method: "POST", headers: { origin: "https://console.example.test", "content-type": "application/json", [CONSOLE_HEADER]: "1" }, body: JSON.stringify({ action: "set_client_choice", project: "acme", aiUse: "off", reason: "asked" }) }),
      deps,
    )) as Response;
    expect(response.status).toBe(409);
  });
});
