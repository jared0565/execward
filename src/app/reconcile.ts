/**
 * Reconciles a model's summary against what actually happened (task 1.7.2, FR-39).
 *
 * The model's account of a run is never the source of truth. Every figure in
 * its summary must be traceable to something the server knows: the user's
 * request, a value a tool or script returned to the model, or the run report.
 * A figure found in none of those is flagged.
 *
 * A flag means "not traceable", not "wrong". A model that adds two returned
 * numbers in its head produces a figure this cannot trace. The honest way to
 * get a traceable figure is to compute it in the script.
 */
import type { RunReport } from "../contracts/code-tool";

export interface Reconciliation {
  /** Figures found in the summary. */
  readonly figures: number;
  /** Figures that could not be traced, as written. */
  readonly unsupported: readonly string[];
  readonly flagged: boolean;
}

/**
 * A number as people write it: 41, 1,204, 3.5, -2. Separators are removed before comparing.
 * Digits joined to a word or a hyphen (run-1, sha256, v2) are names, not figures.
 */
const FIGURE = /(?<![\w.-])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])|(?<![\w.-])-?\d+(?:\.\d+)?(?![\w])/g;

function figuresIn(text: string): { written: string; value: number }[] {
  return [...text.matchAll(FIGURE)].map((match) => ({ written: match[0], value: Number(match[0].replace(/,/g, "")) })).filter((figure) => Number.isFinite(figure.value));
}

function reportFigures(report: RunReport): number[] {
  const calls = Object.values(report.callsByTool);
  return [
    ...calls,
    calls.reduce((sum, count) => sum + count, 0),
    Object.keys(report.callsByTool).length,
    report.recordsRead,
    report.recordsWritten,
    report.errors.length,
    report.retries,
    report.assertions.passed,
    report.assertions.failed,
    report.sideEffects.length,
  ];
}

export interface ReconcileInput {
  /** The model's final answer. */
  readonly summary: string;
  /** The user's request: a figure repeated from it is not a claim about the run. */
  readonly request: string;
  /** Everything returned to the model during the task, as text. */
  readonly returned: readonly string[];
  readonly reports: readonly RunReport[];
}

export function reconcile(input: ReconcileInput): Reconciliation {
  const known = new Set<number>();
  for (const text of [input.request, ...input.returned]) for (const figure of figuresIn(text)) known.add(figure.value);
  for (const report of input.reports) for (const value of reportFigures(report)) known.add(value);

  const claimed = figuresIn(input.summary);
  const unsupported = [...new Set(claimed.filter((figure) => !known.has(figure.value)).map((figure) => figure.written))];
  return { figures: claimed.length, unsupported, flagged: unsupported.length > 0 };
}
