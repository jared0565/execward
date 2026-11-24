/**
 * The production GitHub credential: a GitHub App (task 1.1.2, FR-25; the
 * project owner's decision on 2026-11-24).
 *
 * The owner creates a private GitHub App with read-only permissions and
 * installs it on the repositories ExecWard may read. ExecWard holds the App's
 * private key and nothing longer-lived. When the connector needs a credential
 * it signs a statement that it is the App, good for under ten minutes, and
 * exchanges it at GitHub for an installation token good for about an hour.
 *
 * What is kept where:
 * - The private key: a Worker secret. Read when a token is minted, never logged.
 * - The installation token: this isolate's memory only, until shortly before
 *   it expires. It is never written to the database, the audit log or a log line.
 * - The signed statement: used once and dropped.
 *
 * A failure of any kind gives no token and says nothing about why to the
 * caller, since GitHub's reply or an error's text could carry part of a
 * credential. The connector then reports that it has no credential.
 */

/** How long before a token's stated expiry it is replaced. */
export const TOKEN_RENEW_BEFORE_MS = 5 * 60 * 1000;
/** The signed statement's life. GitHub allows at most ten minutes. */
export const APP_JWT_LIFETIME_S = 9 * 60;
/** The statement is dated a minute back, as GitHub advises, to allow for clocks that differ. */
export const APP_JWT_BACKDATE_S = 60;

export interface GithubAppSettings {
  /** The App's ID: digits. Not a secret, but stored as one so it is in no file. */
  readonly appId: string | undefined;
  /** The ID of the App's installation on the owner's account: digits. */
  readonly installationId: string | undefined;
  /** The App's private key, as the PEM file GitHub gives. */
  readonly privateKeyPem: string | undefined;
}

export interface GithubAppDeps {
  readonly settings: () => GithubAppSettings;
  /** The guarded fetch: it goes to api.github.com and nowhere else. */
  readonly fetch: (url: string, init: { method: "POST"; headers: Record<string, string>; redirect: "manual" }) => Promise<Response>;
  /** Milliseconds. */
  readonly now: () => number;
}

const DIGITS = /^[0-9]{1,20}$/;

function base64Url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A DER length: one byte under 128, otherwise a count of length bytes and then the length. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: readonly number[] | Uint8Array): number[] {
  return [tag, ...derLength(content.length), ...content];
}

/** `rsaEncryption`, with its NULL parameter: the algorithm named in a PKCS#8 wrapper around an RSA key. */
const RSA_ALGORITHM = der(0x30, [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/**
 * The key as PKCS#8, which is the only private-key form the platform imports.
 * GitHub's download is the older PKCS#1 form ("BEGIN RSA PRIVATE KEY"); that is
 * wrapped here, so the owner does not have to convert a key file by hand.
 */
export function pkcs8FromPem(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----/.exec(pem);
  if (!match) throw new Error("not a private key in PEM form");
  const body = Uint8Array.from(atob((match[2] as string).replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  if (match[1] === "PRIVATE KEY") return body;
  return Uint8Array.from(der(0x30, [0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...der(0x04, body)]));
}

/** The statement "this is App `appId`", signed with the App's key. */
export async function appJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8FromPem(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({ iat: now - APP_JWT_BACKDATE_S, exp: now + APP_JWT_LIFETIME_S, iss: appId }))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${base64Url(signature)}`;
}

/**
 * Gives the connector its credential: an installation token, minted when
 * needed and kept in memory until shortly before it expires. `undefined` when
 * the App is not set up or a token could not be had.
 */
export function githubAppToken(deps: GithubAppDeps): () => Promise<string | undefined> {
  let held: { readonly token: string; readonly expiresAt: number } | undefined;
  let minting: Promise<string | undefined> | undefined;

  async function mint(): Promise<string | undefined> {
    const { appId, installationId, privateKeyPem } = deps.settings();
    const app = appId?.trim() ?? "";
    const installation = installationId?.trim() ?? "";
    if (!DIGITS.test(app) || !DIGITS.test(installation) || typeof privateKeyPem !== "string" || privateKeyPem.trim() === "") return undefined;
    try {
      const jwt = await appJwt(app, privateKeyPem, deps.now());
      const response = await deps.fetch(`https://api.github.com/app/installations/${installation}/access_tokens`, {
        method: "POST",
        redirect: "manual",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": "2022-11-28", "user-agent": "execward" },
      });
      if (response.status !== 201) return undefined;
      const reply = (await response.json()) as { token?: unknown; expires_at?: unknown };
      const expiresAt = typeof reply.expires_at === "string" ? Date.parse(reply.expires_at) : Number.NaN;
      if (typeof reply.token !== "string" || reply.token === "" || !Number.isFinite(expiresAt)) return undefined;
      held = { token: reply.token, expiresAt };
      return reply.token;
    } catch {
      // The error's text could hold the key or the statement. Nothing of it is passed on.
      return undefined;
    }
  }

  return async () => {
    if (held !== undefined && deps.now() < held.expiresAt - TOKEN_RENEW_BEFORE_MS) return held.token;
    held = undefined;
    // Calls that arrive together share one request to GitHub.
    minting ??= mint().finally(() => {
      minting = undefined;
    });
    return minting;
  };
}
