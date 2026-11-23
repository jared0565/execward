/**
 * Database-backed stores (tables in migrations/0003_state.sql): quota
 * counters, the owner's switches, the escalation queue and project records.
 *
 * Each has an in-memory twin used by the unit tests. These are the ones a
 * deployed Worker uses, because a Worker's memory is neither shared between
 * instances nor kept between requests.
 *
 * Every write that decides something is one SQL statement, so two Workers
 * doing the same thing at once cannot both win: a counter is added to and
 * read back in one step, a slot is taken only if one is free, and the
 * switches are written only if nobody else wrote first.
 */
import { checkProjectRecord, CLIENT_DATA_GATE, ProjectStoreError, type Gate, type ProjectRecord, type ProjectStore } from "../broker/exposure";
import type { QuotaStore } from "../broker/quotas";
import { INITIAL_CONTROL_STATE, type ControlState, type ControlStore } from "../console/control";
import type { EscalationItem, EscalationStore } from "../console/escalations";
import { DATA_CLASSES, type DataClass } from "../contracts/policy";

/** The part of a D1 database these stores use. */
export interface StateDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
    all<T>(): Promise<{ results: T[] }>;
  };
}

export function d1QuotaStore(db: StateDatabase): QuotaStore {
  return {
    async add(key, windowMs, amount, now) {
      const window = Math.floor(now / windowMs);
      const row = await db
        .prepare("INSERT INTO quota_counters (id, total, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET total = total + excluded.total RETURNING total")
        .bind(`${key}@${windowMs}:${window}`, amount, (window + 1) * windowMs)
        .first<{ total: number }>();
      if (row === null) throw new Error("the counter could not be read back");
      return row.total;
    },
    async acquire(key, holder, limit, ttlMs, now) {
      // A run that died without releasing its slot must not hold it for ever.
      await db.prepare("DELETE FROM quota_slots WHERE key = ?1 AND expires_at <= ?2").bind(key, now).run();
      // Taken only if a slot is free, in one statement.
      const row = await db
        .prepare("INSERT INTO quota_slots (key, holder, expires_at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM quota_slots WHERE key = ?1) < ?4 ON CONFLICT(key, holder) DO NOTHING RETURNING holder")
        .bind(key, holder, now + ttlMs, limit)
        .first<{ holder: string }>();
      return row !== null;
    },
    async release(key, holder) {
      await db.prepare("DELETE FROM quota_slots WHERE key = ?1 AND holder = ?2").bind(key, holder).run();
    },
  };
}

/** Removes counters whose window has ended. Run on a schedule; nothing depends on it for correctness. */
export async function sweepQuotaCounters(db: StateDatabase, now: number): Promise<void> {
  await db.prepare("DELETE FROM quota_counters WHERE expires_at <= ?1").bind(now).run();
}

function parseControlState(json: string, version: number): ControlState {
  const value = JSON.parse(json) as Partial<ControlState> | null;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((entry) => typeof entry === "string");
  if (value === null || typeof value !== "object" || typeof value.codeMode !== "boolean" || typeof value.killed !== "boolean" || !strings(value.pausedProjects) || !strings(value.blockedTools)) {
    // A state that cannot be understood is an error, and every reader fails closed on an error.
    throw new Error("the stored control state is not valid");
  }
  return { ...(value as ControlState), version };
}

export function d1ControlStore(db: StateDatabase): ControlStore {
  return {
    async read() {
      const row = await db.prepare("SELECT version, state FROM control_state WHERE id = ?1").bind(1).first<{ version: number; state: string }>();
      return row === null ? INITIAL_CONTROL_STATE : parseControlState(row.state, row.version);
    },
    async write(next, expectedVersion) {
      const state = JSON.stringify(next);
      const row =
        expectedVersion === INITIAL_CONTROL_STATE.version
          ? // The first write: succeeds only if there is still no row.
            await db.prepare("INSERT INTO control_state (id, version, state) VALUES (1, ?1, ?2) ON CONFLICT(id) DO NOTHING RETURNING version").bind(next.version, state).first<{ version: number }>()
          : await db.prepare("UPDATE control_state SET version = ?1, state = ?2 WHERE id = 1 AND version = ?3 RETURNING version").bind(next.version, state, expectedVersion).first<{ version: number }>();
      return row !== null;
    },
  };
}

export function d1EscalationStore(db: StateDatabase): EscalationStore {
  const parse = (json: string): EscalationItem => JSON.parse(json) as EscalationItem;
  return {
    async put(item) {
      await db
        .prepare("INSERT INTO escalations (id, status, created_at, item) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET status = excluded.status, item = excluded.item")
        .bind(item.id, item.status, item.createdAt, JSON.stringify(item))
        .run();
    },
    async get(id) {
      const row = await db.prepare("SELECT item FROM escalations WHERE id = ?1").bind(id).first<{ item: string }>();
      return row === null ? undefined : parse(row.item);
    },
    async all() {
      return (await db.prepare("SELECT item FROM escalations ORDER BY created_at, id").all<{ item: string }>()).results.map((row) => parse(row.item));
    },
  };
}

export function d1ProjectStore(db: StateDatabase): ProjectStore {
  return {
    async get(project) {
      const row = await db.prepare("SELECT data_class FROM projects WHERE project = ?1").bind(project).first<{ data_class: string }>();
      if (row === null) return undefined;
      if (!DATA_CLASSES.includes(row.data_class as DataClass)) throw new ProjectStoreError("the project's record holds an unknown data class");
      return { project, dataClass: row.data_class as DataClass };
    },
  };
}

/** Sets a project's data class. Refuses client personal data while the gate is uncleared. */
export async function putProjectRecord(db: StateDatabase, record: ProjectRecord, gate: Gate = CLIENT_DATA_GATE): Promise<void> {
  checkProjectRecord(record, gate);
  await db.prepare("INSERT INTO projects (project, data_class) VALUES (?1, ?2) ON CONFLICT(project) DO UPDATE SET data_class = excluded.data_class").bind(record.project, record.dataClass).run();
}
