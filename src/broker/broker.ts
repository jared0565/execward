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
import { CALL_LIMITS, CIRCUIT_BREAKER } from "../limits";
import type { SandboxHost } from "../executor";
import { DefinitionChangedError } from "../registry/definition";
import { pathAllowed, urlAllowed } from "./allowlists";
import { checkAgainstSchema } from "./json-schema";
import { effectivePolicy, pathOf, type PolicyStore } from "./policy-store";
import { countCall, MAX_COUNT_BLOCK, memoryQuotaStore, returnCalls, type QuotaContext } from "./quotas";

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
  /** The upstream's status code, when it gave one. For a sensitive tool this is all a script is told. */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    if (status !== undefined) this.status = status;
  }
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
  /**
   * Where daily call counts are kept (FR-27). Left out, they are counted in
   * memory for this run only, so production wiring must always pass it.
   */
  readonly quotas?: QuotaContext;
  /** Upstream errors in a row before the run is ended. Defaults to `CIRCUIT_BREAKER`. */
  readonly consecutiveUpstreamErrors?: number;
  /** Typed docs for one tool path, for `describe()` (FR-3). */
  readonly docsFor?: (path: string) => Promise<{ readonly typing: string } | undefined>;
  /**
   * The owner's switches, asked before every call (FR-17). Returns why the
   * call must not go ahead: Code Mode off, the kill switch, a paused project
   * or a blocked tool. A run ends at the first such answer.
   */
  readonly control?: (path: string) => Promise<ExecWardError | undefined>;
  /**
   * The highest data class this run may handle (FR-32, FR-38). A tool above
   * it is hidden from search and describe and refused when called. If it is a
   * promise that fails, every call is refused. Left out, there is no cap, so
   * production wiring must always pass it (see src/service.ts).
   */
  readonly maxDataClass?: DataClass | Promise<DataClass>;
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

  /** Ends the run on a security code (FR-41). Every later call is refused too. */
  function end(code: "policy_denied" | "quota_exceeded" | "circuit_open" | "definition_changed" | "code_mode_off", path: string, reason: string): never {
    denials.push({ path, reason });
    // The first refusal is the one reported; the message names the tool, never the arguments.
    // A path with no policy record is whatever the script typed, so it is not
    // repeated: after a read, it could carry that data out in the error (FR-36).
    ended ??= { code, message: `${knownPaths.has(path) ? `the call to "${path}"` : "a call"} was refused: ${reason}` };
    throw new Error(`${code}: ${reason}`);
  }

  /** Paths the policy table has a record for: real tools, not text a script made up. */
  const knownPaths = new Set<string>();

  function deny(path: string, reason: string): never {
    return end("policy_denied", path, reason);
  }

  const quotas: QuotaContext = deps.quotas ?? { store: memoryQuotaStore(), project: "unknown", now: () => Date.now() };
  const breakerLimit = deps.consecutiveUpstreamErrors ?? CIRCUIT_BREAKER.consecutiveUpstreamErrors;
  const callsThisRun = new Map<string, number>();
  let errorsInARow = 0;

  /** The run's data-class cap. A cap that cannot be worked out refuses the call. */
  async function dataClassCap(path: string): Promise<DataClass | undefined> {
    try {
      return await deps.maxDataClass;
    } catch {
      return deny(path, "the project's data class is unavailable");
    }
  }

  function withinCap(record: PolicyRecord, cap: DataClass | undefined): boolean {
    return cap === undefined || DATA_CLASSES.indexOf(record.dataClass) <= DATA_CLASSES.indexOf(cap);
  }

  /** Quotas on one call that has passed every policy check (FR-27). */
  async function checkQuotas(path: string, record: PolicyRecord): Promise<void> {
    const count = (callsThisRun.get(path) ?? 0) + 1;
    callsThisRun.set(path, count);
    const perRun = record.quotas.callsPerRun;
    if (perRun !== undefined && count > perRun) end("quota_exceeded", path, `the tool's limit of ${perRun} calls in one run was reached`);
    // Each count is a write to the database. A script that loops over a tool would pay for
    // one on every call, so calls are counted ahead in growing blocks: 1, 2, 4, up to
    // MAX_COUNT_BLOCK. A block the limit has no room for is not kept; the call is then
    // counted on its own, so the limit is met exactly, never early and never late. What
    // was counted and not used is given back when the run closes.
    const ahead = counted.get(path) ?? { left: 0, block: 1, limit: record.quotas.callsPerDay };
    counted.set(path, ahead);
    if (ahead.left === 0) {
      let over = await countCall(quotas, path, ahead.limit, ahead.block);
      if (over !== undefined && ahead.block > 1) {
        ahead.block = 1;
        over = await countCall(quotas, path, ahead.limit, 1);
      }
      if (over !== undefined) end("quota_exceeded", path, over);
      ahead.left = ahead.block;
      ahead.block = Math.min(ahead.block * 2, MAX_COUNT_BLOCK);
    }
    ahead.left--;
  }

  /** Calls counted against the daily limits and not yet made, for each tool. */
  const counted = new Map<string, { left: number; block: number; limit: number | undefined }>();

  /** The circuit breaker (FR-27): a run that keeps failing upstream is ended, not left to retry for ever. */
  function upstreamFailed(path: string): void {
    errorsInARow++;
    if (errorsInARow >= breakerLimit) end("circuit_open", path, `${errorsInARow} upstream errors in a row`);
  }

  /** Set when the executor says the run is over (a time limit, a fault, or simply the end). */
  let closed = false;

  function guard(path: string): void {
    // Not a refusal: the run is simply over, and nothing more is done for it.
    if (closed) throw new Error("the run has ended");
    if (ended) deny(path, "the run was ended by an earlier refusal");
  }

  /** FR-17: a switch thrown mid-run ends the script at its next call. Nothing carries on. */
  async function switches(path: string): Promise<void> {
    if (!deps.control) return;
    let stopped: ExecWardError | undefined;
    try {
      stopped = await deps.control(path);
    } catch {
      stopped = { code: "code_mode_off", message: "the control state is unavailable, so nothing is run" };
    }
    if (stopped) end(stopped.code === "code_mode_off" ? "code_mode_off" : "policy_denied", path, stopped.message);
  }

  async function lookup(path: string): Promise<PolicyRecord | undefined> {
    try {
      const record = await deps.store.get(path);
      if (record !== undefined) knownPaths.add(path);
      return record;
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
    async close() {
      closed = true;
      const unused = [...counted].filter(([, ahead]) => ahead.left > 0);
      counted.clear();
      for (const [path, ahead] of unused) await returnCalls(quotas, path, ahead.limit, ahead.left);
    },
    provenance() {
      return { dataClass: this.dataClass(), records: reads.reduce((sum, read) => sum + read.records, 0) };
    },
    dataClass: () =>
      reads.length === 0 ? undefined : DATA_CLASSES[Math.max(...reads.map((read) => DATA_CLASSES.indexOf(read.dataClass)))],

    async callTool(path, args) {
      guard(path);
      await switches(path);
      const record = await lookup(path);
      const policy = effectivePolicy(record);
      if (!policy.classified || record === undefined) deny(path, "the tool has no policy record");
      if (!scriptMayCall(policy)) deny(path, "the tool may only be called directly, not from a script");
      if (policy.tier !== 0) deny(path, `tier ${policy.tier} tools cannot be called from a script yet`);
      const cap = await dataClassCap(path);
      if (cap !== undefined && DATA_CLASSES.indexOf(policy.dataClass) > DATA_CLASSES.indexOf(cap)) {
        deny(path, `the tool returns ${policy.dataClass} data, and this run may only handle ${cap} data`);
      }

      let definition: ToolDefinition | undefined;
      try {
        definition = await deps.definitionFor(record);
      } catch (cause) {
        // FR-22: a tool that no longer matches its pin is blocked, and says so.
        if (cause instanceof DefinitionChangedError) return end("definition_changed", path, cause.message);
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
      await checkQuotas(path, record);

      // The checks above wait on stores. Meanwhile a sibling call may have been refused, a
      // switch thrown or the time limit reached. Nothing is sent upstream for a run that is over.
      guard(path);

      let result: unknown;
      try {
        result = await deps.upstream({ record, args });
      } catch (cause) {
        guard(path);
        upstreamFailed(path);
        if (record.sensitive) {
          // A sensitive tool's own words could carry what it guards, so they are not passed on:
          // only that it failed, and the status code if it gave one. Nothing was delivered, so
          // nothing counts as read, and a failed read does not block what comes after it.
          const status = (cause as { status?: unknown } | null)?.status;
          const coded = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? ` with status ${status}` : "";
          throw new Error(`upstream_error: the tool failed${coded}; its message is withheld because the tool is marked sensitive`, { cause });
        }
        // The upstream's own words are untrusted text: passed to the script, cut short, and nothing more.
        const said = cause instanceof Error ? cause.message : String(cause);
        const shown = said.length > 500 ? `${said.slice(0, 500)}...` : said;
        // They are also data from that tool, so they count as a read of its class (FR-36).
        reads.push({ path, server: record.server, tool: record.tool, dataClass: record.dataClass, sensitive: record.sensitive, bytes: new TextEncoder().encode(shown).length, records: 0 });
        throw new Error(`upstream_error: ${shown}`, { cause });
      }
      // A result that arrives after the run ended is not handed over.
      guard(path);
      let accepted: unknown;
      try {
        accepted = accept(path, record, definition, result);
      } catch (cause) {
        // A result the broker had to reject is an upstream failure too.
        upstreamFailed(path);
        throw cause;
      }
      errorsInARow = 0;
      return accepted;
    },

    async search(query) {
      guard("search");
      // The script's mistake, not a refusal. Without a limit, one call could buy any amount of host work.
      if (query.length > SEARCH_LIMITS.maxQueryChars) throw new Error(`schema_invalid: a search query may be at most ${SEARCH_LIMITS.maxQueryChars} characters`);
      await switches("search");
      let records: readonly PolicyRecord[];
      try {
        records = await deps.store.list();
      } catch {
        return deny("search", "the policy table is unavailable");
      }
      const cap = await dataClassCap("search");
      // A script only ever learns about tools it could call.
      const paths = records
        .filter((record) => scriptMayCall(record) && record.tier === 0 && withinCap(record, cap))
        .map(pathOf)
        .sort();
      const wanted = [...new Set(searchWords(query))].slice(0, SEARCH_LIMITS.maxWords);
      if (wanted.length === 0) return paths;
      // Models ask in phrases ("list workflow runs CI"), not in exact names. So a tool need not
      // match every word: each is scored by the words its name or description holds, and
      // those scoring at least half the best are returned, best first. Measured in task 1.9.5:
      // requiring every word in the name returned nothing for most first searches.
      const scored: { path: string; score: number }[] = [];
      for (const path of paths) {
        const name = path.toLowerCase();
        let docs = "";
        try {
          docs = (await deps.docsFor?.(path))?.typing.toLowerCase() ?? "";
        } catch {
          // The name alone is searched.
        }
        const holds = (text: string, word: string): boolean => (word.length < 3 ? searchWords(text).includes(word) : text.includes(word));
        // A word in the name counts three times a word found only in the description.
        const score = wanted.reduce((sum, word) => sum + (holds(name, word) ? 3 : holds(docs, word) ? 1 : 0), 0);
        if (score > 0) scored.push({ path, score });
      }
      const best = Math.max(0, ...scored.map((entry) => entry.score));
      return scored
        .filter((entry) => entry.score * 2 >= best)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .map((entry) => entry.path);
    },

    async describe(path) {
      guard(path);
      if (path.length > SEARCH_LIMITS.maxPathChars) throw new Error("no tool of that name is available to scripts");
      await switches(path);
      const record = await lookup(path);
      if (record === undefined || !scriptMayCall(record) || record.tier !== 0 || !withinCap(record, await dataClassCap(path))) {
        // Not a security event: asking about a name is not an attempt to use it.
        throw new Error(`no tool named "${path}" is available to scripts`);
      }
      let docs: { readonly typing: string } | undefined;
      try {
        docs = await deps.docsFor?.(path);
      } catch {
        docs = undefined;
      }
      return { path, server: record.server, tool: record.tool, tier: record.tier, dataClass: record.dataClass, ...(docs ? { typing: docs.typing } : {}) };
    },
  };
}

/** How much one discovery call may ask of the host. */
export const SEARCH_LIMITS = { maxQueryChars: 500, maxWords: 16, maxPathChars: 200 } as const;

/** Lower-case words of a search, with a plural "s" dropped so "runs" finds "run". */
function searchWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}
