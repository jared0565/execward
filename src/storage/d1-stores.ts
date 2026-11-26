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
import { checkClientChoice, checkProjectRecord, CLIENT_DATA_GATE, ProjectStoreError, type ClientChoice, type Gate, type ProjectRecord, type ProjectStore } from "../broker/exposure";
import type { QuotaStore } from "../broker/quotas";
import type { AttemptState, AttemptStore } from "../code-tool/stored-attempts";
import type { ExecWardError } from "../contracts/errors";
import type { SettingsSeen, SettingsSeenStore } from "../mcp/switch-notice";
import { INITIAL_CONTROL_STATE, type ControlState, type ControlStore } from "../console/control";
import type { EscalationItem, EscalationStore } from "../console/escalations";
import { DATA_CLASSES, type DataClass } from "../contracts/policy";
import { STATS_MAX_GROUPS, type StatsDimension, type StatsStore } from "../meter/stats";

/** The part of a D1 database these stores use. */
export interface StateDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> };
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

/** One row per metered run, for the stats report (table in migrations/0006_meter_records.sql). */
export function d1StatsStore(db: StateDatabase): StatsStore {
  // The column for each grouping. Fixed here: a name from outside never reaches the SQL.
  const column: Record<StatsDimension, string> = { session: "session", project: "project", client: "client", model: "model" };
  return {
    async write(row) {
      await db
        .prepare(
          "INSERT INTO meter_records (run_id, at, project, session, client, model, kind, estimated_saving, verified, verification_tokens) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(run_id) DO NOTHING",
        )
        .bind(row.runId, row.at, row.project, row.session, row.client, row.model, row.kind, row.estimatedSavingTokens, row.verified ? 1 : 0, row.verificationTokens)
        .run();
    },
    async groups(dimension, since) {
      const name = column[dimension];
      const found = await db
        .prepare(
          `SELECT ${name} AS key, COUNT(*) AS runs, SUM(estimated_saving) AS saving, SUM(verified) AS verified, SUM(verification_tokens) AS tokens FROM meter_records WHERE at >= ?1 GROUP BY ${name} ORDER BY runs DESC, key ASC LIMIT ${STATS_MAX_GROUPS}`,
        )
        .bind(since)
        .all<{ key: string; runs: number; saving: number; verified: number; tokens: number }>();
      return found.results.map((row) => ({ key: row.key, runs: row.runs, estimated: { savingTokens: row.saving }, measured: { verifiedRuns: row.verified, verificationTokens: row.tokens } }));
    },
    async trim(before) {
      await db.prepare("DELETE FROM meter_records WHERE at < ?1").bind(before).run();
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

/** The switch settings each caller last saw (table in migrations/0005_switches_seen.sql). */
export function d1SettingsSeenStore(db: StateDatabase): SettingsSeenStore {
  return {
    async get(key) {
      const row = await db.prepare("SELECT settings FROM switches_seen WHERE key = ?1").bind(key).first<{ settings: string }>();
      return row === null ? undefined : (JSON.parse(row.settings) as SettingsSeen);
    },
    async put(key, settings, now) {
      await db
        .prepare("INSERT INTO switches_seen (key, settings, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET settings = ?2, updated_at = ?3")
        .bind(key, JSON.stringify(settings), now)
        .run();
    },
  };
}

/** Failed runs in a row, per caller and project (table in migrations/0004_attempts.sql). */
export function d1AttemptStore(db: StateDatabase): AttemptStore {
  interface Row {
    failures: number;
    closed: string | null;
    escalation_id: string | null;
    updated_at: number;
  }
  return {
    async get(key) {
      const row = await db.prepare("SELECT failures, closed, escalation_id, updated_at FROM attempt_state WHERE key = ?1").bind(key).first<Row>();
      if (row === null) return undefined;
      const state: AttemptState = {
        failures: row.failures,
        updatedAt: row.updated_at,
        ...(row.closed === null ? {} : { closed: JSON.parse(row.closed) as ExecWardError }),
        ...(row.escalation_id === null ? {} : { escalationId: row.escalation_id }),
      };
      return state;
    },
    async fail(key, now, staleBefore) {
      // Added to and read back in one statement: two runs failing at once are both counted.
      const row = await db
        .prepare(
          "INSERT INTO attempt_state (key, failures, updated_at) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET failures = CASE WHEN attempt_state.updated_at < ?3 THEN 1 ELSE attempt_state.failures + 1 END, updated_at = ?2 RETURNING failures",
        )
        .bind(key, now, staleBefore)
        .first<{ failures: number }>();
      if (row === null) throw new Error("the attempt count could not be written");
      return row.failures;
    },
    async close(key, closed, now) {
      // One statement: of several runs closing at once, only the first gets a row back.
      const row = await db
        .prepare(
          "INSERT INTO attempt_state (key, failures, closed, updated_at) VALUES (?1, 0, ?2, ?3) ON CONFLICT(key) DO UPDATE SET closed = ?2, updated_at = ?3 WHERE attempt_state.closed IS NULL RETURNING key",
        )
        .bind(key, JSON.stringify(closed), now)
        .first<{ key: string }>();
      return row !== null;
    },
    async setEscalation(key, escalationId) {
      await db.prepare("UPDATE attempt_state SET escalation_id = ?2 WHERE key = ?1").bind(key, escalationId).run();
    },
    async touch(key, now) {
      await db.prepare("UPDATE attempt_state SET updated_at = ?2 WHERE key = ?1").bind(key, now).run();
    },
    async clear(key) {
      await db.prepare("DELETE FROM attempt_state WHERE key = ?1").bind(key).run();
    },
    async clearOpen(key) {
      // One statement: a closure written a moment ago by another run is not deleted.
      await db.prepare("DELETE FROM attempt_state WHERE key = ?1 AND closed IS NULL").bind(key).run();
    },
  };
}

export function d1ProjectStore(db: StateDatabase): ProjectStore {
  return {
    async get(project) {
      const row = await db.prepare("SELECT data_class, client_ai_use, client_limit FROM projects WHERE project = ?1").bind(project).first<ProjectRow>();
      if (row === null) return undefined;
      return projectFromRow(project, row);
    },
  };
}

interface ProjectRow {
  readonly data_class: string;
  readonly client_ai_use: string | null;
  readonly client_limit: string | null;
}

/** A stored row as a record. Anything in it that is not understood is refused, so a run for it does not start. */
function projectFromRow(project: string, row: ProjectRow): ProjectRecord {
  if (!DATA_CLASSES.includes(row.data_class as DataClass)) throw new ProjectStoreError("the project's record holds an unknown data class");
  if (row.client_ai_use === null && row.client_limit === null) return { project, dataClass: row.data_class as DataClass };
  if (row.client_ai_use !== null && row.client_ai_use !== "off") throw new ProjectStoreError("the project's record holds an unknown client choice");
  if (row.client_limit !== null && !DATA_CLASSES.includes(row.client_limit as DataClass)) throw new ProjectStoreError("the project's record holds an unknown client limit");
  const clientChoice: ClientChoice = { aiUse: row.client_ai_use === "off" ? "off" : "on", ...(row.client_limit === null ? {} : { limit: row.client_limit as DataClass }) };
  return { project, dataClass: row.data_class as DataClass, clientChoice };
}

/** Every project with a record, by name. For the owner's console. */
export async function listProjectRecords(db: StateDatabase): Promise<ProjectRecord[]> {
  const { results } = await db.prepare("SELECT project, data_class, client_ai_use, client_limit FROM projects ORDER BY project").all<ProjectRow & { project: string }>();
  return results.map((row) => projectFromRow(row.project, row));
}

/**
 * Records what a project's client has asked for. Only for a project that has a record:
 * returns `false`, and changes nothing, when it has none. The project's own data class
 * is not touched. `undefined` clears the choice.
 */
export async function setClientChoice(db: StateDatabase, project: string, choice: ClientChoice | undefined): Promise<boolean> {
  if (choice !== undefined) checkClientChoice(choice);
  const row = await db
    .prepare("UPDATE projects SET client_ai_use = ?2, client_limit = ?3 WHERE project = ?1 RETURNING project")
    .bind(project, choice?.aiUse === "off" ? "off" : null, choice?.limit ?? null)
    .first<{ project: string }>();
  return row !== null;
}

/** Sets a project's data class. Refuses client personal data while the gate is uncleared. */
export async function putProjectRecord(db: StateDatabase, record: ProjectRecord, gate: Gate = CLIENT_DATA_GATE): Promise<void> {
  checkProjectRecord(record, gate);
  await db.prepare("INSERT INTO projects (project, data_class) VALUES (?1, ?2) ON CONFLICT(project) DO UPDATE SET data_class = excluded.data_class").bind(record.project, record.dataClass).run();
}
