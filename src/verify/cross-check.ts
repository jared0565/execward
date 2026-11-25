/**
 * The cross-check of critical figures (task 2.2.2, FR-43).
 *
 * A script marks a figure as critical by calling
 * `critical(name, value, { op, rows })`: its name, the value the script got,
 * and the numbers it was worked out from. The sandbox only writes that down.
 * This code, in the host, works the figure out again from the same numbers,
 * by its own arithmetic, and compares.
 *
 * What it catches: a wrong calculation over the right numbers. Text added to
 * text in place of numbers, a loop that stops one short, a filter applied to
 * the total and not to the rows, a rounding step in the wrong place.
 *
 * What it cannot catch: the wrong numbers. If the script read half the pages
 * and hands over half the rows, both sides agree on the same wrong total.
 * And a figure the script does not declare is not checked at all.
 *
 * What was declared comes out of the sandbox, so it is untrusted: every part
 * is checked here, and a declaration that cannot be read is never an agreement.
 */
import { CROSS_CHECK_LIMITS } from "../limits";

export const CROSS_CHECK_OPS = ["sum", "count", "min", "max", "average"] as const;
export type CrossCheckOp = (typeof CROSS_CHECK_OPS)[number];

/** One declared figure, after the host has worked it out again. Numbers only, and a name the script chose. */
export interface CheckedFigure {
  readonly name: string;
  readonly op: CrossCheckOp;
  /** How many numbers it was worked out from. */
  readonly rows: number;
  /** What the script said. */
  readonly declared: number;
  /** What the host got. */
  readonly recomputed: number;
  readonly agrees: boolean;
}

export type CrossCheckResult = { readonly ok: true; readonly figures: readonly CheckedFigure[] } | { readonly ok: false; readonly problem: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A sum that does not lose small numbers beside large ones (Neumaier's method), so the order of the rows does not matter. */
function sum(rows: readonly number[]): number {
  let total = 0;
  let lost = 0;
  for (const row of rows) {
    const next = total + row;
    lost += Math.abs(total) >= Math.abs(row) ? total - next + row : row - next + total;
    total = next;
  }
  return total + lost;
}

/** The figure, worked out here. `undefined` when the question has no answer: the smallest of no numbers. */
export function recompute(op: CrossCheckOp, rows: readonly number[]): number | undefined {
  if (op === "count") return rows.length;
  if (op === "sum") return sum(rows);
  if (rows.length === 0) return undefined;
  if (op === "average") return sum(rows) / rows.length;
  let best = rows[0] as number;
  for (const row of rows) if (op === "min" ? row < best : row > best) best = row;
  return best;
}

/**
 * Two ways of adding the same numbers can differ in the last binary places.
 * That is not a disagreement. The allowance is one part in a million million
 * of the figure, and never less than a thousand-millionth: below a penny on
 * any amount under a thousand million.
 */
export function figuresAgree(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, 1e-12 * Math.max(Math.abs(a), Math.abs(b)));
}

/** Checks everything a run declared. `declared` is what came out of the sandbox, as it came. */
export function crossCheck(declared: unknown): CrossCheckResult {
  if (!Array.isArray(declared)) return { ok: false, problem: "what was declared could not be read" };
  if (declared.length > CROSS_CHECK_LIMITS.maxFigures) return { ok: false, problem: `more than ${CROSS_CHECK_LIMITS.maxFigures} figures were declared` };
  const figures: CheckedFigure[] = [];
  let rowsSeen = 0;
  for (const [index, entry] of (declared as unknown[]).entries()) {
    const which = `figure ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, problem: `${which} could not be read` };
    const { name, value, op, rows } = entry as { name?: unknown; value?: unknown; op?: unknown; rows?: unknown };
    if (typeof name !== "string" || name === "" || name.length > CROSS_CHECK_LIMITS.maxNameChars) return { ok: false, problem: `${which} has no usable name` };
    if (!isFiniteNumber(value)) return { ok: false, problem: `${which} has a value that is not a number` };
    if (typeof op !== "string" || !(CROSS_CHECK_OPS as readonly string[]).includes(op)) return { ok: false, problem: `${which} names a calculation that is not one of ${CROSS_CHECK_OPS.join(", ")}` };
    if (!Array.isArray(rows) || !rows.every(isFiniteNumber)) return { ok: false, problem: `${which} has rows that are not all numbers` };
    rowsSeen += rows.length;
    if (rowsSeen > CROSS_CHECK_LIMITS.maxRows) return { ok: false, problem: `more than ${CROSS_CHECK_LIMITS.maxRows} rows were declared` };
    const recomputed = recompute(op as CrossCheckOp, rows);
    if (recomputed === undefined) return { ok: false, problem: `${which} asks for the ${op} of no rows` };
    figures.push({ name, op: op as CrossCheckOp, rows: rows.length, declared: value, recomputed, agrees: figuresAgree(value, recomputed) });
  }
  return { ok: true, figures };
}
