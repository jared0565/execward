/**
 * The database reached from a command line, for the emergency stop
 * (incident runbook step 1; FR-27).
 *
 * The stores in ./d1-stores and ../audit/log speak to a database through
 * prepared statements. From a script there is no binding, only a command that
 * runs one piece of SQL. This puts each statement's values into its text and
 * hands it to that command, so the same stores, with the same version check
 * and the same audit chain, work from a script.
 *
 * Values are written as SQL literals: a number as itself, text in single
 * quotes with every quote doubled. Nothing else is accepted.
 */

/** Runs one SQL statement and returns its rows and how many rows it changed. */
export type SqlRunner = (sql: string) => Promise<{ readonly results: readonly unknown[]; readonly changes: number }>;

export function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a number that is not finite cannot be written to the database");
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\0")) throw new Error("text with a NUL character cannot be written to the database");
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new Error(`a ${typeof value} cannot be written to the database`);
}

/** Replaces each `?N` with the literal for the Nth value. A `?` inside quoted text in the statement is left alone. */
export function inlineSql(sql: string, values: readonly unknown[]): string {
  const used = new Set<number>();
  let out = "";
  let quote: string | undefined;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index] as string;
    if (quote !== undefined) {
      out += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === "?") {
      const digits = /^\d+/.exec(sql.slice(index + 1))?.[0];
      if (digits === undefined) throw new Error("only numbered placeholders (?1, ?2) are supported");
      const position = Number(digits);
      if (position < 1 || position > values.length) throw new Error(`the statement uses ?${position} but ${values.length} values were given`);
      used.add(position);
      out += sqlLiteral(values[position - 1]);
      index += digits.length;
      continue;
    }
    out += char;
  }
  if (used.size !== values.length) throw new Error(`${values.length} values were given but the statement uses ${used.size}`);
  return out;
}

/** A database with the shape the stores expect, over a runner. */
export function cliDatabase(run: SqlRunner) {
  const statement = (sql: string, values: readonly unknown[]) => ({
    async first<T>(): Promise<T | null> {
      return ((await run(inlineSql(sql, values))).results[0] as T | undefined) ?? null;
    },
    async run(): Promise<{ meta: { changes: number } }> {
      return { meta: { changes: (await run(inlineSql(sql, values))).changes } };
    },
    async all<T>(): Promise<{ results: T[] }> {
      return { results: [...(await run(inlineSql(sql, values))).results] as T[] };
    },
  });
  return {
    prepare(sql: string) {
      return { ...statement(sql, []), bind: (...values: unknown[]) => statement(sql, values) };
    },
  };
}
