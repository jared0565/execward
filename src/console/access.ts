/**
 * Who is asking, according to Cloudflare Access (task 1.6.1, FR-49).
 *
 * The owner chose Cloudflare Access for sign-in on 2026-11-23. Access sits in
 * front of the Worker, signs the person in and asks for the second factor.
 * The platform then hands the Worker `ctx.access` for that request. Nothing in
 * a request's headers, address or body is read here, so nothing a caller
 * sends can claim to be the owner.
 *
 * Everything fails closed. A request Access did not authenticate, a missing
 * setting, an identity that cannot be read, another person: all are anonymous.
 *
 * What this cannot see: that the second factor was really asked for. That is
 * set on the Access application, and it is Access that enforces it. See
 * docs/decisions/1.6.1-console-sign-in.md.
 */
import type { Principal } from "./console";

/** `ctx.access` as the platform supplies it. Absent when Access did not authenticate the request. */
export interface AccessContext {
  readonly aud?: unknown;
  readonly getIdentity?: () => Promise<unknown>;
}

export interface AccessSettings {
  /** The audience tag of the Access application that guards the console. */
  readonly audience: string | undefined;
  /** The owner's sign-in address. Held as a secret, never in this repository. */
  readonly ownerEmail: string | undefined;
}

const ANONYMOUS: Principal = { kind: "anonymous" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function principalFromAccess(access: AccessContext | undefined, settings: AccessSettings): Promise<Principal> {
  const audience = settings.audience?.trim() ?? "";
  const ownerEmail = settings.ownerEmail?.trim().toLowerCase() ?? "";
  // Not set up: nobody is the owner.
  if (audience === "" || ownerEmail === "") return ANONYMOUS;
  if (!isRecord(access)) return ANONYMOUS;
  // Signed in to some other Access application is not signed in to this one.
  if (access.aud !== audience) return ANONYMOUS;
  if (typeof access.getIdentity !== "function") return ANONYMOUS;

  let identity: unknown;
  try {
    identity = await access.getIdentity();
  } catch {
    return ANONYMOUS;
  }
  if (!isRecord(identity)) return ANONYMOUS;
  // A service token is a credential a program holds. It is never the owner.
  if (identity.service_token_status === true || (typeof identity.service_token_id === "string" && identity.service_token_id !== "")) {
    return { kind: "model_client", id: "access-service-token" };
  }
  if (typeof identity.email !== "string" || identity.email.trim().toLowerCase() !== ownerEmail) return ANONYMOUS;

  // `iat` is when the person signed in, in seconds. Without it the sign-in has no age, and is refused later.
  const signedInAt = typeof identity.iat === "number" && Number.isFinite(identity.iat) && identity.iat > 0 ? identity.iat * 1000 : undefined;
  // The audit log names the owner by Access's user id, not by email address.
  const id = typeof identity.user_uuid === "string" && /^[A-Za-z0-9-]{1,64}$/.test(identity.user_uuid) ? `owner:${identity.user_uuid}` : "owner";
  return { kind: "owner", id, twoFactorAt: signedInAt };
}
