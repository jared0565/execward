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
import { pathAllowed, urlAllowed } from "./allowlists";
import { checkAgainstSchema } from "./json-schema";
import { effectivePolicy, pathOf, type PolicyStore } from "./policy-store";

/** The pinned definition of one wrapped tool. Pinning and its hash are task 1.5.4. */
export interface ToolDefinition {
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: unknown;
}

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
  /** The tool's definition, or `undefined` when there is none. No definition, no call. */
  readonly definitionFor: (record: PolicyRecord) => Promise<ToolDefinition | undefined>;
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

      let definition: ToolDefinition | undefined;
      try {
        definition = await deps.definitionFor(record);
      } catch {
        return deny(path, "the tool's definition is unavailable");
      }
      if (definition === undefined) deny(path, "the tool has no definition to check its arguments against");

      // FR-34. A call with no arguments is checked as an empty object.
      const checked = checkAgainstSchema(args === undefined ? {} : args, definition.inputSchema);
      if (checked.problems.length > 0) {
        // The script's own mistake, which it may catch and fix: not a security refusal.
        throw new Error(`schema_invalid: ${checked.problems.slice(0, 3).join("; ")}`);
      }
      for (const found of checked.located) {
        const allowed =
          found.kind === "url" ? urlAllowed(found.value, record.destinationAllowlist) : pathAllowed(found.value, record.pathAllowlist ?? []);
        // Reaching outside the allowlist is a security refusal. The value itself is not repeated.
        if (!allowed) deny(path, `the ${found.kind === "url" ? "URL" : "path"} in "${found.at}" is not on the tool's allowlist`);
      }
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
