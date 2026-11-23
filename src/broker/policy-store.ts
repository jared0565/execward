/**
 * The policy table (task 1.3.1, FR-50, FR-32): where the broker looks up what a
 * tool is allowed to do.
 *
 * Default deny has two parts, and both are here:
 *   1. A tool with no record gets `UNCLASSIFIED_TOOL_POLICY`: highest data
 *      class, tier 2, direct-only. A script can never call it.
 *   2. A store that cannot answer, or a stored row that does not match the
 *      contract, throws `PolicyStoreError`. The broker treats that as a denial.
 *      A broken record is never "repaired" into something more permissive.
 */
import { policyRecordSchema, UNCLASSIFIED_TOOL_POLICY, type PolicyRecord } from "../contracts/policy";
import { toolPath } from "../contracts/sandbox-api";

export class PolicyStoreError extends Error {
  override readonly name = "PolicyStoreError";
}

export interface PolicyStore {
  /** The record for one tool path, or `undefined` when there is none. */
  get(path: string): Promise<PolicyRecord | undefined>;
  /** Every record. Used by `search()`. */
  list(): Promise<readonly PolicyRecord[]>;
}

/** What the broker enforces for a tool. `classified` is false when no record exists. */
export type EffectivePolicy =
  | ({ readonly classified: true } & PolicyRecord)
  | ({ readonly classified: false } & typeof UNCLASSIFIED_TOOL_POLICY);

export function effectivePolicy(record: PolicyRecord | undefined): EffectivePolicy {
  return record === undefined ? { classified: false, ...UNCLASSIFIED_TOOL_POLICY } : { classified: true, ...record };
}

export function pathOf(record: Pick<PolicyRecord, "server" | "tool">): string {
  return toolPath(record.server, record.tool);
}

/** Checks a stored value against contract 4. Throws rather than guess. */
function readRecord(path: string, value: unknown): PolicyRecord {
  const parsed = policyRecordSchema.safeParse(value);
  if (!parsed.success) throw new PolicyStoreError(`the policy record for "${path}" does not match the contract`);
  if (pathOf(parsed.data) !== path) throw new PolicyStoreError(`the policy record stored under "${path}" is for a different tool`);
  return parsed.data;
}

/** A store held in memory, for tests and for the local eval harness. */
export function memoryPolicyStore(records: readonly unknown[]): PolicyStore {
  const byPath = new Map<string, PolicyRecord>();
  for (const value of records) {
    const parsed = policyRecordSchema.safeParse(value);
    if (!parsed.success) throw new PolicyStoreError("a policy record does not match the contract");
    const path = pathOf(parsed.data);
    if (byPath.has(path)) throw new PolicyStoreError(`two policy records share the path "${path}"`);
    byPath.set(path, parsed.data);
  }
  return {
    get: async (path) => byPath.get(path),
    list: async () => [...byPath.values()],
  };
}

/** The part of a D1 database the store uses. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
    all<T>(): Promise<{ results: T[] }>;
  };
}

function parseRow(path: string, json: string): PolicyRecord {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new PolicyStoreError(`the policy record for "${path}" is not JSON`);
  }
  return readRecord(path, value);
}

/** The store backed by D1 (table in migrations/0001_policy.sql). */
export function d1PolicyStore(db: D1Like): PolicyStore {
  return {
    async get(path) {
      let row: { record: string } | null;
      try {
        row = await db.prepare("SELECT record FROM policy WHERE path = ?1").bind(path).first<{ record: string }>();
      } catch (cause) {
        throw new PolicyStoreError(`the policy table could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return row === null ? undefined : parseRow(path, row.record);
    },
    async list() {
      let rows: { path: string; record: string }[];
      try {
        rows = (await db.prepare("SELECT path, record FROM policy ORDER BY path").all<{ path: string; record: string }>()).results;
      } catch (cause) {
        throw new PolicyStoreError(`the policy table could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return rows.map((row) => parseRow(row.path, row.record));
    },
  };
}

/** Writes one record. Used by setup and tests; the owner console will use it later. */
export async function putPolicyRecord(db: D1Like, value: unknown): Promise<void> {
  const parsed = policyRecordSchema.safeParse(value);
  if (!parsed.success) throw new PolicyStoreError("the policy record does not match the contract");
  await db
    .prepare("INSERT INTO policy (path, record) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET record = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    .bind(pathOf(parsed.data), JSON.stringify(parsed.data))
    .run();
}
