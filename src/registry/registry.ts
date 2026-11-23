/**
 * The tool registry (tasks 1.5.3 and 1.5.4, FR-3, FR-22): the approved, pinned
 * definition of every wrapped tool, checked against what the tool says about
 * itself today.
 *
 * Approval pins a definition. At call time the tool's current definition is
 * compared with its pin:
 *
 *   same hash                                   -> allowed
 *   only the description changed, and the new
 *   one passes the scan and the length cap      -> allowed, and noted
 *   anything else                               -> `definition_changed`
 *
 * The schemas decide what a call may send and receive, so a schema change
 * always needs the owner. A description is only words, so a clean rewording
 * is let through rather than stopping work every time an upstream tidies up.
 */
import type { ToolDefinition } from "../broker/broker";
import type { PolicyRecord } from "../contracts/policy";
import { DefinitionChangedError, definitionHash, descriptionProblems, pathOfDefinition, schemaHash, type ToolDefinitionRecord } from "./definition";
import { typingFor } from "./typings";

export interface Pin {
  readonly path: string;
  readonly definition: ToolDefinitionRecord;
  readonly hash: string;
  readonly schemaHash: string;
}

export class RegistryError extends Error {
  override readonly name = "RegistryError";
}

/**
 * Approves a definition: checks it and returns its pin. The pin's `hash` is
 * what goes in the tool's policy record as `definitionHash`.
 */
export async function approve(definition: ToolDefinitionRecord): Promise<Pin> {
  const problems = descriptionProblems(definition.description);
  if (problems.length > 0) throw new RegistryError(`the description of "${definition.server}/${definition.tool}" cannot be approved: it ${problems.join("; it ")}`);
  return { path: pathOfDefinition(definition), definition, hash: await definitionHash(definition), schemaHash: await schemaHash(definition) };
}

export interface Registry {
  /** For the broker: the definition to check a call against, or a thrown `DefinitionChangedError`. */
  definitionFor(record: PolicyRecord): Promise<ToolDefinition | undefined>;
  /** Typed docs for one tool path (FR-3), or `undefined` when it is not pinned. */
  docsFor(path: string): Promise<{ readonly path: string; readonly typing: string } | undefined>;
  /** Descriptions that changed and were let through, for the audit log. */
  readonly reapproved: readonly { readonly path: string; readonly hash: string }[];
}

export interface RegistryDeps {
  readonly pins: readonly Pin[];
  /** What the tool says about itself now: the upstream's live listing. `undefined` when it is gone. */
  readonly current: (path: string) => Promise<ToolDefinitionRecord | undefined>;
}

export function registry(deps: RegistryDeps): Registry {
  const pins = new Map<string, Pin>();
  for (const pin of deps.pins) {
    // Two tools whose names clean to the same function name would be indistinguishable to a script.
    if (pins.has(pin.path)) throw new RegistryError(`two tools share the function name "${pin.path}"`);
    pins.set(pin.path, pin);
  }
  const reapproved: { path: string; hash: string }[] = [];

  /** The live definition, if it may be used; throws when it has changed in a way that needs the owner. */
  async function checked(pin: Pin, pinnedHash: string): Promise<ToolDefinitionRecord> {
    // The policy record and the registry must agree on what was approved.
    if (pinnedHash !== pin.hash) throw new DefinitionChangedError(`the policy record for "${pin.path}" does not match the pinned definition`);
    const live = await deps.current(pin.path);
    if (live === undefined) throw new DefinitionChangedError(`"${pin.path}" is no longer offered by its server`);
    if (pathOfDefinition(live) !== pin.path) throw new DefinitionChangedError(`"${pin.path}" now answers under a different name`);
    const liveHash = await definitionHash(live);
    if (liveHash === pin.hash) return live;
    if ((await schemaHash(live)) !== pin.schemaHash) throw new DefinitionChangedError(`the schema of "${pin.path}" changed since it was approved`);
    if (descriptionProblems(live.description).length > 0) throw new DefinitionChangedError(`the description of "${pin.path}" changed since it was approved, and the new one did not pass the safety scan`);
    if (!reapproved.some((entry) => entry.path === pin.path && entry.hash === liveHash)) reapproved.push({ path: pin.path, hash: liveHash });
    return live;
  }

  return {
    reapproved,
    async definitionFor(record) {
      const pin = pins.get(pathOfDefinition(record));
      if (pin === undefined) return undefined;
      const live = await checked(pin, record.definitionHash);
      return { description: live.description, inputSchema: live.inputSchema, ...(live.outputSchema === undefined ? {} : { outputSchema: live.outputSchema }) };
    },
    async docsFor(path) {
      const pin = pins.get(path);
      if (pin === undefined) return undefined;
      // Docs come from the pinned definition: what was approved is what the model is shown.
      return { path, typing: typingFor(pin.definition).trim() };
    },
  };
}
