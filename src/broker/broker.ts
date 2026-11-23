/**
 * The broker (tasks 1.3.1 and 1.3.2, FR-6, FR-13): the host side of every call
 * a script makes. The script's `tools.x()` arrives here; nothing reaches a
 * wrapped tool unless the policy table says a script may call it.
 *
 * This first version enforces caller rules and tiers only:
 *   - no record              -> refused (default deny, FR-50)
 *   - caller rule "direct"   -> refused
 *   - tier 1 or 2            -> refused: the dry run and approvals do not exist yet
 *   - the policy store fails -> refused (fail closed)
 *
 * A refusal is a security event (FR-41). It ends the run: every later call in
 * the same run is refused too, and the run is reported as `policy_denied` even
 * if the script caught the error. That stops a script probing the policy.
 */
import type { ExecWardError } from "../contracts/errors";
import type { PolicyRecord } from "../contracts/policy";
import { scriptMayCall } from "../contracts/policy";
import type { SandboxHost } from "../executor";
import { effectivePolicy, pathOf, type PolicyStore } from "./policy-store";

/** Carries one allowed call to the wrapped tool. The MCP client, once it exists. */
export type Upstream = (call: { readonly record: PolicyRecord; readonly args: unknown }) => Promise<unknown>;

export interface BrokerDenial {
  readonly path: string;
  readonly reason: string;
}

export interface BrokerHost extends SandboxHost {
  /** Set once the broker has refused a call. The run must end with this error. */
  securityError(): ExecWardError | undefined;
  /** Every refusal in this run, in order, for the audit log. */
  readonly denials: readonly BrokerDenial[];
}

export interface BrokerDeps {
  readonly store: PolicyStore;
  readonly upstream: Upstream;
}

/** Builds the broker for one run. Never shared between runs. */
export function brokerHost(deps: BrokerDeps): BrokerHost {
  const denials: BrokerDenial[] = [];
  let ended: ExecWardError | undefined;

  function deny(path: string, reason: string): never {
    denials.push({ path, reason });
    // The first refusal is the one reported; the message names the tool, never the arguments.
    ended ??= { code: "policy_denied", message: `the call to "${path}" was refused: ${reason}` };
    throw new Error(`policy_denied: ${reason}`);
  }

  function guard(path: string): void {
    if (ended) deny(path, "the run was ended by an earlier refusal");
  }

  async function lookup(path: string): Promise<PolicyRecord | undefined> {
    try {
      return await deps.store.get(path);
    } catch {
      // Fail closed. The store's own error is not passed to the script.
      return deny(path, "the policy table is unavailable");
    }
  }

  return {
    denials,
    securityError: () => ended,

    async callTool(path, args) {
      guard(path);
      const record = await lookup(path);
      const policy = effectivePolicy(record);
      if (!policy.classified || record === undefined) deny(path, "the tool has no policy record");
      if (!scriptMayCall(policy)) deny(path, "the tool may only be called directly, not from a script");
      if (policy.tier !== 0) deny(path, `tier ${policy.tier} tools cannot be called from a script yet`);
      return deps.upstream({ record, args });
    },

    async search(query) {
      guard("search");
      let records: readonly PolicyRecord[];
      try {
        records = await deps.store.list();
      } catch {
        return deny("search", "the policy table is unavailable");
      }
      const wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
      // A script only ever learns about tools it could call.
      return records
        .filter((record) => scriptMayCall(record) && record.tier === 0)
        .map(pathOf)
        .filter((path) => wanted.every((word) => path.toLowerCase().includes(word)))
        .sort();
    },

    async describe(path) {
      guard(path);
      const record = await lookup(path);
      if (record === undefined || !scriptMayCall(record) || record.tier !== 0) {
        // Not a security event: asking about a name is not an attempt to use it.
        throw new Error(`no tool named "${path}" is available to scripts`);
      }
      return { path, server: record.server, tool: record.tool, tier: record.tier, dataClass: record.dataClass };
    },
  };
}
