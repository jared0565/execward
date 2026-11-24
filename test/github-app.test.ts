import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_JWT_BACKDATE_S, APP_JWT_LIFETIME_S, appJwt, githubAppToken, pkcs8FromPem, TOKEN_RENEW_BEFORE_MS, type GithubAppSettings } from "../src/connectors/github-app";

const NOW = Date.UTC(2026, 10, 24, 12);
const HOUR = 3_600_000;

// A key made for this test run and thrown away. Nothing here is a real credential.
let pkcs1Pem: string;
let pkcs8Pem: string;
let publicKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  pkcs1Pem = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  pkcs8Pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKey = pair.publicKey;
});

const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

async function verifies(jwt: string): Promise<boolean> {
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  const key = await crypto.subtle.importKey("spki", publicKey.export({ type: "spki", format: "der" }), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`));
}

function github(reply: (call: number) => Response = () => Response.json({ token: "installation-token-1", expires_at: new Date(NOW + HOUR).toISOString() }, { status: 201 })) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; redirect: string } }[] = [];
  return {
    calls,
    fetch: async (url: string, init: { method: "POST"; headers: Record<string, string>; redirect: "manual" }) => {
      calls.push({ url, init });
      return reply(calls.length);
    },
  };
}

const settings = (over: Partial<GithubAppSettings> = {}): (() => GithubAppSettings) => () => ({ appId: "123456", installationId: "7890123", privateKeyPem: pkcs1Pem, ...over });

describe("the GitHub App's signed statement", () => {
  it("is signed with the App's key, in the form GitHub gives the key (PKCS#1) and in PKCS#8", async () => {
    for (const pem of [pkcs1Pem, pkcs8Pem]) expect(await verifies(await appJwt("123456", pem, NOW))).toBe(true);
  });

  it("names the App, is dated a minute back and lasts under ten minutes", async () => {
    const [header, payload] = (await appJwt("123456", pkcs1Pem, NOW)).split(".") as [string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims).toEqual({ iss: "123456", iat: NOW / 1000 - APP_JWT_BACKDATE_S, exp: NOW / 1000 + APP_JWT_LIFETIME_S });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
  });

  it("wraps a PKCS#1 key into exactly the PKCS#8 form of the same key", () => {
    expect(Buffer.from(pkcs8FromPem(pkcs1Pem)).equals(Buffer.from(pkcs8FromPem(pkcs8Pem)))).toBe(true);
  });

  it.each<[string, string]>([
    ["text that is not a key", "not a key"],
    ["a public key", "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"],
    ["a key whose ends do not match", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"],
  ])("refuses %s", (_label, pem) => {
    expect(() => pkcs8FromPem(pem)).toThrow();
  });
});

describe("the installation token (task 1.1.2, FR-25)", () => {
  it("is asked for at GitHub's own address, for the installation, with the signed statement and no redirect followed", async () => {
    const api = github();
    expect(await githubAppToken({ settings: settings(), fetch: api.fetch, now: () => NOW })()).toBe("installation-token-1");
    expect(api.calls).toHaveLength(1);
    const call = api.calls[0];
    expect(call?.url).toBe("https://api.github.com/app/installations/7890123/access_tokens");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(await verifies((call?.init.headers.authorization ?? "").replace(/^Bearer /, ""))).toBe(true);
  });

  it("is kept in memory and used again, then replaced shortly before it expires", async () => {
    let clock = NOW;
    const api = github((call) => Response.json({ token: `installation-token-${call}`, expires_at: new Date(clock + HOUR).toISOString() }, { status: 201 }));
    const token = githubAppToken({ settings: settings(), fetch: api.fetch, now: () => clock });
    expect(await token()).toBe("installation-token-1");
    clock += HOUR - TOKEN_RENEW_BEFORE_MS - 1;
    expect(await token()).toBe("installation-token-1");
    expect(api.calls).toHaveLength(1);
    clock += 1;
    expect(await token()).toBe("installation-token-2");
    expect(api.calls).toHaveLength(2);
  });

  it("asks GitHub once when several calls arrive together", async () => {
    const api = github();
    const token = githubAppToken({ settings: settings(), fetch: api.fetch, now: () => NOW });
    expect(await Promise.all([token(), token(), token()])).toEqual(["installation-token-1", "installation-token-1", "installation-token-1"]);
    expect(api.calls).toHaveLength(1);
  });

  it.each<[string, Partial<GithubAppSettings>]>([
    ["no App ID", { appId: undefined }],
    ["an App ID that is not digits", { appId: "123/../456" }],
    ["no installation ID", { installationId: "  " }],
    ["an installation ID that is not digits", { installationId: "1?x=2" }],
    ["no private key", { privateKeyPem: undefined }],
  ])("gives no token, and asks GitHub nothing, with %s", async (_label, change) => {
    const api = github();
    expect(await githubAppToken({ settings: settings(change), fetch: api.fetch, now: () => NOW })()).toBeUndefined();
    expect(api.calls).toHaveLength(0);
  });

  it.each<[string, () => Response]>([
    ["GitHub refuses", () => Response.json({ message: "Bad credentials" }, { status: 401 })],
    ["GitHub answers with a redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })],
    ["the reply has no token", () => Response.json({ expires_at: new Date(NOW + HOUR).toISOString() }, { status: 201 })],
    ["the reply has no expiry", () => Response.json({ token: "t" }, { status: 201 })],
    ["the reply is not JSON", () => new Response("<html>", { status: 201 })],
  ])("gives no token when %s, and tries again next time", async (_label, reply) => {
    const api = github((call) => (call === 1 ? reply() : Response.json({ token: "installation-token-2", expires_at: new Date(NOW + HOUR).toISOString() }, { status: 201 })));
    const token = githubAppToken({ settings: settings(), fetch: api.fetch, now: () => NOW });
    expect(await token()).toBeUndefined();
    expect(await token()).toBe("installation-token-2");
  });

  it("gives no token, and throws nothing, when the key is not a key or the request fails", async () => {
    const api = github();
    expect(await githubAppToken({ settings: settings({ privateKeyPem: "not a key" }), fetch: api.fetch, now: () => NOW })()).toBeUndefined();
    const broken = async (): Promise<Response> => {
      throw new Error(`could not send: ${pkcs1Pem}`);
    };
    expect(await githubAppToken({ settings: settings(), fetch: broken, now: () => NOW })()).toBeUndefined();
  });

  it("reads the settings when a token is minted, so a key changed in the secret store is picked up", async () => {
    const api = github();
    let ready = false;
    const token = githubAppToken({ settings: () => (ready ? settings()() : settings({ privateKeyPem: undefined })()), fetch: api.fetch, now: () => NOW });
    expect(await token()).toBeUndefined();
    ready = true;
    expect(await token()).toBe("installation-token-1");
  });
});
