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
import { DATA_CLASSES, scriptMayCall, type DataClass, type PolicyRecord } from "../contracts/policy";
import { CALL_LIMITS } from "../limits";
import type { SandboxHost } from "../executor";
import { pathAllowed, urlAllowed } from "./allowlists";
import { checkAgainstSchema } from "./json-schema";
import { effectivePolicy, pathOf, type PolicyStore } from "./policy-store";

/** The pinned definition of one wrapped tool. Pinning and its hash are task 1.5.4. */
export interface ToolDefinition {
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: unknown;
  /** JSON Schema for the tool's result, when the tool declares one. */
  readonly outputSchema?: unknown;
}

/**
 * Thrown by an upstream when the wrapped tool itself reports an error (an MCP
 * `isError` result). The script receives it as an error it can catch (FR-7).
 */
export class UpstreamToolError extends Error {
  override readonly name = "UpstreamToolError";
}

/** Something unusual the broker let through but noted for the audit log (FR-29). */
export interface BrokerFlag {
  readonly path: string;
  readonly kind: "large_argument";
  /** Size of the arguments as JSON. */
  readonly bytes: number;
}

/** One result the broker accepted and handed to the script, with its tags (FR-35). */
export interface TaggedRead {
  readonly path: string;
  readonly server: string;
  readonly tool: string;
  readonly dataClass: DataClass;
  readonly sensitive: boolean;
  /** Size of the result as JSON. */
  readonly bytes: number;
  /** Records in the result: the length of a list, otherwise one (FR-36). */
  readonly records: number;
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
  /** Every result handed to the script in this run, in order, with its tags (FR-35). */
  readonly reads: readonly TaggedRead[];
  /** Calls that went out but were noted as unusual (FR-29). */
  readonly flags: readonly BrokerFlag[];
  /**
   * The highest data class the script has been given in this run, or
   * `undefined` when it has read nothing. Whatever the script returns or sends
   * on is treated as carrying this class: a script can reshape a value, so the
   * tag has to live with the run, outside the script's reach.
   */
  dataClass(): DataClass | undefined;
  /** What the code tool needs for output hygiene (FR-36). */
  provenance(): { readonly dataClass: DataClass | undefined; readonly records: number };
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
  const reads: TaggedRead[] = [];
  const flags: BrokerFlag[] = [];
  let ended: ExecWardError | undefined;

  /**
   * The data-flow rule (FR-29). An outbound tool can send data out of the
   * project, so two things stop a call to one:
   *   - the run has already read something sensitive, unless the owner has
   *     listed destinations for this tool and the call names only those;
   *   - the arguments are unusually large, which is what carrying data out
   *     looks like.
   * Unusually large arguments to any other tool are let through and flagged.
   */
  function checkDataFlow(path: string, record: PolicyRecord, args: unknown, destinations: number): void {
    const bytes = new TextEncoder().encode(JSON.stringify(args) ?? "").length;
    const large = bytes > CALL_LIMITS.largeArgumentBytes;
    if (record.outbound) {
      if (large) deny(path, `the arguments to an outbound tool are unusually large (${bytes} bytes)`);
      const sensitive = reads.find((read) => read.sensitive);
      // An empty destination list approves nothing, so by default every such call stops here.
      const approved = record.destinationAllowlist.length > 0 && destinations > 0;
      if (sensitive && !approved) {
        deny(path, `the run has read sensitive data from "${sensitive.path}", and this tool can send data out`);
      }
    } else if (large) {
      flags.push({ path, kind: "large_argument", bytes });
    }
  }

  /** Checks one result and records its tags. Returns the copy the script is given. */
  function accept(path: string, record: PolicyRecord, definition: ToolDefinition, result: unknown): unknown {
    let json: string | undefined;
    try {
      json = JSON.stringify(result);
    } catch {
      json = undefined;
    }
    // `undefined`, a function or a value that points back at itself has no JSON form.
    if (json === undefined) throw new Error("schema_invalid: the tool's result is not valid JSON data");
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > CALL_LIMITS.maxToolResultBytes) {
      throw new Error(`result_too_large: the tool's result is ${bytes} bytes; the limit is ${CALL_LIMITS.maxToolResultBytes}. Ask for less, for example one page at a time`);
    }
    // The script gets the copy that was measured, not the object the upstream still holds.
    const copy = JSON.parse(json) as unknown;
    if (definition.outputSchema !== undefined) {
      const checked = checkAgainstSchema(copy, definition.outputSchema, "allow");
      if (checked.problems.length > 0) {
        throw new Error(`schema_invalid: the tool's result does not match its schema (${checked.problems.slice(0, 3).join("; ")})`);
      }
    }
    const records = Array.isArray(copy) ? copy.length : 1;
    reads.push({ path, server: record.server, tool: record.tool, dataClass: record.dataClass, sensitive: record.sensitive, bytes, records });
    return copy;
  }

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
    reads,
    flags,
    securityError: () => ended,
    provenance() {
      return { dataClass: this.dataClass(), records: reads.reduce((sum, read) => sum + read.records, 0) };
    },
    dataClass: () =>
      reads.length === 0 ? undefined : DATA_CLASSES[Math.max(...reads.map((read) => DATA_CLASSES.indexOf(read.dataClass)))],

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
      // Every URL found above is already on the tool's list; this counts them.
      checkDataFlow(path, record, args, checked.located.filter((found) => found.kind === "url").length);

      let result: unknown;
      try {
        result = await deps.upstream({ record, args });
      } catch (cause) {
        // The upstream's own words are untrusted text: passed to the script, cut short, and nothing more.
        const said = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`upstream_error: ${said.length > 500 ? `${said.slice(0, 500)}...` : said}`, { cause });
      }
      return accept(path, record, definition, result);
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
