/**
 * Compares what Cloudflare says a deployed Worker can reach with the
 * allowlist (task 1.1.6, FR-24).
 *
 * The configuration check (./config-check) covers the file in this
 * repository. It cannot see a binding or a secret that someone added in the
 * Cloudflare dashboard. This does: it reads the bindings of the version that
 * is live, as the platform reports them.
 */
import { ALLOWED_BINDINGS, ALLOWED_ROUTES, ALLOWED_SECRETS, COMPATIBILITY_DATE, type AllowedBinding } from "./bindings";

/** One binding of a deployed version, as `wrangler versions view --json` reports it. */
export interface DeployedBinding {
  readonly type: string;
  readonly name: string;
  readonly [setting: string]: unknown;
}

export interface DeployedVersion {
  readonly bindings: readonly DeployedBinding[];
  readonly compatibilityDate: unknown;
  /** Names of the Worker's secrets. */
  readonly secrets: readonly string[];
}

/** The platform's name for each config section, and the setting that says what the binding points at. */
const PLATFORM: Readonly<Record<string, { readonly type: string; readonly target?: { readonly platform: string; readonly config: string } }>> = {
  worker_loaders: { type: "worker_loader" },
  d1_databases: { type: "d1", target: { platform: "database_id", config: "database_id" } },
  r2_buckets: { type: "r2_bucket", target: { platform: "bucket_name", config: "bucket_name" } },
  send_email: { type: "send_email" },
};

/** Problems, in plain words. Empty means the deployed Worker reaches what the allowlist names and nothing else. */
export function deployedProblems(version: DeployedVersion, allowed: readonly AllowedBinding[] = ALLOWED_BINDINGS, allowedSecrets: readonly string[] = ALLOWED_SECRETS): string[] {
  const problems: string[] = [];
  const expected = allowed.map((entry) => {
    const platform = PLATFORM[entry.section];
    if (!platform) throw new Error(`no platform name is known for "${entry.section}"`);
    return { name: entry.binding, type: platform.type, target: platform.target, wanted: platform.target ? entry.settings?.[platform.target.config] : undefined };
  });

  for (const binding of version.bindings) {
    // The platform may list a secret among the bindings. An allowed one is not a problem; any other falls through.
    if (binding.type === "secret_text" && allowedSecrets.includes(binding.name)) continue;
    const match = expected.find((entry) => entry.name === binding.name);
    if (!match) {
      problems.push(`the deployed Worker has a binding "${binding.name}" (${binding.type}) that is not on the allowlist`);
      continue;
    }
    if (binding.type !== match.type) problems.push(`the binding "${binding.name}" is a ${binding.type}, not a ${match.type}`);
    else if (match.target && binding[match.target.platform] !== match.wanted) problems.push(`the binding "${binding.name}" points at something other than the allowlist names`);
  }
  for (const entry of expected) {
    const count = version.bindings.filter((binding) => binding.name === entry.name).length;
    if (count !== 1) problems.push(`the binding "${entry.name}" should be deployed once, found ${count}`);
  }
  // A secret is something the Worker could use, whatever the code says. Only the named ones may exist.
  for (const secret of version.secrets) {
    if (!allowedSecrets.includes(secret)) problems.push(`the deployed Worker holds a secret named "${secret}" that is not on the allowlist`);
  }
  if (version.compatibilityDate !== COMPATIBILITY_DATE) problems.push(`the deployed compatibility date is ${JSON.stringify(version.compatibilityDate)}, not ${COMPATIBILITY_DATE}`);
  return problems;
}

/** What one of the Worker's addresses answered to a request with no sign-in. `status` is undefined when it could not be reached. */
export interface AddressProbe {
  readonly host: string;
  readonly status: number | undefined;
  /** The `Location` header, when the answer was a redirect. */
  readonly location?: string;
}

/**
 * Problems with how the Worker's addresses answer a visitor who has not signed in.
 * The allowlist comparison above says what the Worker can reach; it does not say who can
 * reach the Worker. Each address must turn such a visitor away: a refusal (401 or 403),
 * or a redirect to Cloudflare Access's sign-in page. Anything else means the address is
 * open, or is not being checked at all.
 */
export function exposureProblems(probes: readonly AddressProbe[], hosts: readonly string[] = ALLOWED_ROUTES.map((route) => route.pattern)): string[] {
  const problems: string[] = [];
  for (const host of hosts) {
    const probe = probes.find((candidate) => candidate.host === host);
    if (probe === undefined) {
      problems.push(`the address ${host} was not checked`);
      continue;
    }
    if (probe.status === undefined) {
      problems.push(`the address ${host} could not be reached, so it is not known whether it is guarded`);
      continue;
    }
    if (probe.status === 401 || probe.status === 403) continue;
    if (probe.status === 302 || probe.status === 303) {
      let to: string | undefined;
      try {
        to = new URL(probe.location ?? "").hostname;
      } catch {
        to = undefined;
      }
      if (to !== undefined && to.endsWith(".cloudflareaccess.com")) continue;
      problems.push(`the address ${host} sends a visitor who has not signed in somewhere other than Cloudflare Access's sign-in page`);
      continue;
    }
    problems.push(`the address ${host} answered a visitor who has not signed in with status ${probe.status}, not a refusal`);
  }
  return problems;
}
