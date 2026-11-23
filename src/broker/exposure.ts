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
 * A run is allowed the lower of the two.
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

export interface ProjectRecord {
  readonly project: string;
  /** The highest data class this project's runs may handle. */
  readonly dataClass: DataClass;
}

/** Refuses a project record the gate does not allow. Call it wherever a record is written. */
export function checkProjectRecord(record: ProjectRecord, gate: Gate = CLIENT_DATA_GATE): void {
  if (!DATA_CLASSES.includes(record.dataClass)) throw new ProjectStoreError(`"${String(record.dataClass)}" is not a data class`);
  if (record.dataClass === "client_personal" && !gate.cleared) {
    throw new ProjectStoreError(`the project "${record.project}" cannot be set to client personal data until gate ${CLIENT_DATA_GATE.task} is cleared`);
  }
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
  /** The lower of the two: what this run may handle and return. */
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
  return { provider, projectClass, providerCeiling: ceiling, allowed: lowerClass(projectClass, ceiling) };
}
