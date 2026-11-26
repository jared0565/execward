/**
 * Data classes per project, and which model providers may receive which class
 * (task 1.3.7, FR-38, FR-32).
 *
 * Whatever a script returns goes to the model that called the `code` tool, and
 * so to that model's provider. Two things cap what a run may handle:
 *
 *   - the project's own data class, set by the owner (no record means `public`);
 *   - the route the calling client uses to reach its provider. Approval depends
 *     on the route, not only the provider: an API account under commercial
 *     terms is approved; a personal plan of the same provider is not
 *     (docs/research/0.1.6-provider-data-terms.md).
 *
 * A run is allowed the lower of the two. The project's client can lower it
 * further, or ask for no AI use at all (`ClientChoice`).
 */
import { DATA_CLASSES, type DataClass } from "../contracts/policy";

export interface ProviderRoute {
  readonly label: string;
  /** Approved for confidential data, and for client personal data once the gate is cleared. */
  readonly approved: boolean;
}

export const PROVIDER_ROUTES = {
  anthropic_api_commercial: { label: "Anthropic API, organisation account under the Commercial Terms", approved: true },
  openai_api_business: { label: "OpenAI API, business account under the Services Agreement", approved: true },
  chatgpt_business_enterprise: { label: "ChatGPT Business or Enterprise", approved: true },
  claude_personal_plan: { label: "Claude Free, Pro or Max, including Claude Code signed in with one", approved: false },
  chatgpt_personal_plan: { label: "ChatGPT Free, Plus or Pro, including Codex signed in with one", approved: false },
  /** A client that has not shown how it is signed in. Treated as not approved. */
  unknown: { label: "Unknown route", approved: false },
} as const satisfies Record<string, ProviderRoute>;

export type ProviderRouteId = keyof typeof PROVIDER_ROUTES;

export function isProviderRoute(value: unknown): value is ProviderRouteId {
  return typeof value === "string" && Object.hasOwn(PROVIDER_ROUTES, value);
}

/**
 * The first-real-client-data gate (task G.7): a DPIA, a transfer risk
 * assessment and the sub-processor checks. Until the owner records it as
 * cleared, no project and no provider route may handle client personal data.
 * Changing this value is the act of clearing the gate, and belongs in the
 * pull request that records G.7 as done.
 */
export const CLIENT_DATA_GATE = { cleared: false, task: "G.7" } as const;

export interface Gate {
  readonly cleared: boolean;
}

function rank(dataClass: DataClass): number {
  return DATA_CLASSES.indexOf(dataClass);
}

export function lowerClass(a: DataClass, b: DataClass): DataClass {
  return rank(a) <= rank(b) ? a : b;
}

export function isAbove(dataClass: DataClass, limit: DataClass): boolean {
  return rank(dataClass) > rank(limit);
}

/** The highest class a provider route may receive (FR-38). */
export function providerCeiling(route: ProviderRouteId, gate: Gate = CLIENT_DATA_GATE): DataClass {
  if (!PROVIDER_ROUTES[route].approved) return "internal";
  return gate.cleared ? "client_personal" : "confidential";
}

export class ProjectStoreError extends Error {
  override readonly name = "ProjectStoreError";
}

/**
 * What the project's client has asked for (the client notice, "Your choices"). A client
 * can ask that AI tools are not used on their work, or that they see less. A choice only
 * ever tightens: it cannot give a run more than the project's own class allows.
 */
export interface ClientChoice {
  /** `off`: the client has asked that AI tools are not used on this project. No run starts. */
  readonly aiUse: "on" | "off";
  /** The highest data class the client lets AI tools handle. Left out, the project's own class stands. */
  readonly limit?: DataClass;
}

/** What a run is told when the project's client has asked for no AI use. Fixed words. */
export const CLIENT_OPTED_OUT_MESSAGE = "the client of this project has asked that AI tools are not used on it, so nothing was run. Only the owner can change this";

export interface ProjectRecord {
  readonly project: string;
  /** The highest data class this project's runs may handle. */
  readonly dataClass: DataClass;
  /** Absent until a choice is recorded for the project's client. */
  readonly clientChoice?: ClientChoice;
}

/** Refuses a client choice that is not in a form the service can act on. Call it wherever one is written or read. */
export function checkClientChoice(choice: ClientChoice): void {
  if (choice.aiUse !== "on" && choice.aiUse !== "off") throw new ProjectStoreError(`"${String(choice.aiUse)}" is not a choice for AI use`);
  if (choice.limit !== undefined && !DATA_CLASSES.includes(choice.limit)) throw new ProjectStoreError(`"${String(choice.limit)}" is not a data class`);
}

/** Refuses a project record the gate does not allow. Call it wherever a record is written. */
export function checkProjectRecord(record: ProjectRecord, gate: Gate = CLIENT_DATA_GATE): void {
  if (!DATA_CLASSES.includes(record.dataClass)) throw new ProjectStoreError(`"${String(record.dataClass)}" is not a data class`);
  if (record.dataClass === "client_personal" && !gate.cleared) {
    throw new ProjectStoreError(`the project "${record.project}" cannot be set to client personal data until gate ${CLIENT_DATA_GATE.task} is cleared`);
  }
  if (record.clientChoice !== undefined) checkClientChoice(record.clientChoice);
}

export interface ProjectStore {
  get(project: string): Promise<ProjectRecord | undefined>;
}

export function memoryProjectStore(records: readonly ProjectRecord[], gate: Gate = CLIENT_DATA_GATE): ProjectStore {
  const byName = new Map<string, ProjectRecord>();
  for (const record of records) {
    checkProjectRecord(record, gate);
    byName.set(record.project, record);
  }
  return { get: async (project) => byName.get(project) };
}

export interface Exposure {
  readonly provider: ProviderRouteId;
  /** The project's own class. `public` when the project has no record (FR-32). */
  readonly projectClass: DataClass;
  readonly providerCeiling: DataClass;
  /** The limit the project's client set, when they set one. */
  readonly clientLimit?: DataClass;
  /** The lowest of them: what this run may handle and return. */
  readonly allowed: DataClass;
}

/**
 * Works out what one run may handle. Throws `ProjectStoreError` when the
 * project's record cannot be read; the caller must then refuse the run.
 */
export async function exposureFor(store: ProjectStore, project: string, route: unknown, gate: Gate = CLIENT_DATA_GATE): Promise<Exposure> {
  // Anything not recognised is the unknown route: never a guess at a better one.
  const provider: ProviderRouteId = isProviderRoute(route) ? route : "unknown";
  let record: ProjectRecord | undefined;
  try {
    record = await store.get(project);
  } catch (cause) {
    throw new ProjectStoreError(`the project's record could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  let projectClass: DataClass = record?.dataClass ?? "public";
  if (!DATA_CLASSES.includes(projectClass)) throw new ProjectStoreError("the project's record holds an unknown data class");
  // A record written before the gate, or behind its back, does not get past it.
  if (projectClass === "client_personal" && !gate.cleared) projectClass = "confidential";
  const ceiling = providerCeiling(provider, gate);
  const clientLimit = record?.clientChoice?.limit;
  // A limit that is not a data class is not guessed at: the run does not start.
  if (clientLimit !== undefined && !DATA_CLASSES.includes(clientLimit)) throw new ProjectStoreError("the project's record holds an unknown client limit");
  const allowed = lowerClass(projectClass, ceiling);
  // The client's limit can only lower what the run gets, never raise it.
  if (clientLimit === undefined) return { provider, projectClass, providerCeiling: ceiling, allowed };
  return { provider, projectClass, providerCeiling: ceiling, clientLimit, allowed: lowerClass(allowed, clientLimit) };
}
