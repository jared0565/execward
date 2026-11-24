/**
 * The GitHub App's signed statement, made on Cloudflare (task 1.1.2). The key
 * handling was written and tested on Node; this shows the Workers runtime
 * imports the same key and signs the same way. The key is made for this run
 * and thrown away: it is a credential for nothing. Run with
 * `npm run test:deployed`.
 */
import { generateKeyPairSync } from "node:crypto";
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

async function sign(body: unknown): Promise<{ status: number; jwt?: string }> {
  const response = await fetch(`${URL_BASE}/github-app`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  return { status: response.status, ...((await response.json()) as { jwt?: string }) };
}

describe("the GitHub App's signed statement on Cloudflare (task 1.1.2)", { timeout: 60_000 }, () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

  it.each(["pkcs1", "pkcs8"] as const)("is signed from a %s key, and the signature verifies", async (type) => {
    const pem = pair.privateKey.export({ type, format: "pem" }).toString();
    const { status, jwt } = await sign({ appId: "123456", privateKeyPem: pem });
    expect(status).toBe(200);
    const [header, payload, signature] = (jwt ?? "").split(".") as [string, string, string];
    const key = await crypto.subtle.importKey("spki", pair.publicKey.export({ type: "spki", format: "der" }), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe("123456");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("refuses text that is not a key, without saying more", async () => {
    expect(await sign({ appId: "123456", privateKeyPem: "not a key" })).toEqual({ status: 400, error: "not usable" });
  });
});
