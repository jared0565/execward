/**
 * The token meter (tasks 1.8.1 and 1.8.2, FR-19).
 *
 * It estimates what a run saved by keeping tool results out of the model's
 * context. Three levels: off, summary (one record per run) and detailed (the
 * same, plus sizes per tool call, never content).
 *
 * Three rules it keeps:
 *   - Off means no tokenizer runs at all.
 *   - It adds nothing to what the model sees. The reply is not touched.
 *   - It stores counts only. No tool content is kept.
 *
 * Every figure is an estimate and is labelled so. The saving is a
 * counterfactual: with direct calls the model might have taken more or fewer
 * steps. The only real figure is the measured one from the eval (Phase 0).
 *
 * The meter is separate from the audit log. If it fails, the run is not affected.
 */

export type MeterLevel = "off" | "summary" | "detailed";

export const METER_LEVELS: readonly MeterLevel[] = ["off", "summary", "detailed"];

/**
 * The level used when none is named. Summary since Gate 1 passed on 2026-11-24
 * (task 1.9.8, the owner's answer on the meter): one record per run. Off is
 * still available, but only by naming it.
 */
export const DEFAULT_METER_LEVEL: MeterLevel = "summary";

export interface Tokenizer {
  readonly name: string;
  count(text: string): number;
}

/**
 * A rough count: one token per four bytes of UTF-8. No model family's real
 * tokenizer is bundled, so this stands in for all of them. It is good enough
 * to compare runs with each other and not good enough to quote as a bill.
 */
export const approximateTokenizer: Tokenizer = {
  name: "approximate (1 token per 4 bytes)",
  count: (text) => Math.ceil(new TextEncoder().encode(text).length / 4),
};

export interface MeterCall {
  readonly path: string;
  readonly resultBytes: number;
  readonly resultTokens: number;
}

export interface MeterRecord {
  readonly runId: string;
  readonly project: string;
  readonly level: "summary" | "detailed";
  /** Always true. Kept in the record so a figure can never travel without its label. */
  readonly estimated: true;
  readonly tokenizer: string;
  /** Tokens in the script the model wrote. */
  readonly scriptTokens: number;
  /** Tokens in the final value sent back. */
  readonly returnedTokens: number;
  /** Tokens in every tool result that stayed in the sandbox. */
  readonly keptOutTokens: number;
  /** Tokens in what `search()` and `describe()` returned. */
  readonly discoveryTokens: number;
  /** Typings for the full catalog, minus typings fetched through `describe()`. */
  readonly definitionsNotLoadedTokens: number;
  /** Kept-out plus definitions not loaded, minus script, returned and discovery tokens. May be negative. */
  readonly estimatedSavingTokens: number;
  /** Sizes per tool call. Present only at the detailed level. */
  readonly calls?: readonly MeterCall[];
  /** Free labels for grouping reports: client, model and the like. */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface MeterSink {
  write(record: MeterRecord): Promise<void>;
}

export function memoryMeterSink(): MeterSink & { readonly records: MeterRecord[] } {
  const records: MeterRecord[] = [];
  return { records, write: async (record) => void records.push(record) };
}

/** What the meter is told during one run. Every method is safe to call at any level. */
export interface RunMeter {
  toolResult(path: string, result: unknown): void;
  discovery(kind: "search" | "describe", result: unknown): void;
  /** Ends the run's metering and writes its record. Never throws. */
  finish(facts: { readonly script: string; readonly returned: unknown }): Promise<MeterRecord | undefined>;
}

export interface MeterFactory {
  readonly level: MeterLevel;
  start(run: { readonly runId: string; readonly project: string }): RunMeter;
}

export interface MeterOptions {
  /** Left out, it is `DEFAULT_METER_LEVEL`. */
  readonly level?: MeterLevel;
  readonly sink: MeterSink;
  readonly tokenizer?: Tokenizer;
  /** The typings a model would have been given for every tool, had there been no discovery. */
  readonly catalogTypings?: () => string;
  readonly labels?: Readonly<Record<string, string>>;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** The arithmetic of the PRD's metering table, apart from any counting. */
export function estimatedSaving(counts: {
  readonly keptOutTokens: number;
  readonly definitionsNotLoadedTokens: number;
  readonly scriptTokens: number;
  readonly returnedTokens: number;
  readonly discoveryTokens: number;
}): number {
  return counts.keptOutTokens + counts.definitionsNotLoadedTokens - counts.scriptTokens - counts.returnedTokens - counts.discoveryTokens;
}

const OFF: RunMeter = { toolResult: () => undefined, discovery: () => undefined, finish: async () => undefined };

export function meter(options: MeterOptions): MeterFactory {
  // Off touches nothing: not the tokenizer, not the catalog, not the sink.
  const level = options.level ?? DEFAULT_METER_LEVEL;
  if (level === "off") return { level: "off", start: () => OFF };

  const tokenizer = options.tokenizer ?? approximateTokenizer;
  let catalogTokens: number | undefined;

  return {
    level,
    start(run) {
      let keptOutTokens = 0;
      let discoveryTokens = 0;
      let describedTokens = 0;
      const calls: MeterCall[] = [];
      // A meter must never break a run, so every count is guarded.
      const guarded = (work: () => void): void => {
        try {
          work();
        } catch {
          // The figure is lost; the run is not.
        }
      };

      return {
        toolResult(path, result) {
          guarded(() => {
            const text = textOf(result);
            const resultTokens = tokenizer.count(text);
            keptOutTokens += resultTokens;
            if (level === "detailed") calls.push({ path, resultBytes: new TextEncoder().encode(text).length, resultTokens });
          });
        },
        discovery(kind, result) {
          guarded(() => {
            discoveryTokens += tokenizer.count(textOf(result));
            if (kind === "describe") {
              const typing = typeof result === "object" && result !== null ? (result as { typing?: unknown }).typing : undefined;
              if (typeof typing === "string") describedTokens += tokenizer.count(typing);
            }
          });
        },
        async finish(facts) {
          try {
            catalogTokens ??= options.catalogTypings ? tokenizer.count(options.catalogTypings()) : 0;
            const counts = {
              scriptTokens: tokenizer.count(facts.script),
              returnedTokens: tokenizer.count(textOf(facts.returned)),
              keptOutTokens,
              discoveryTokens,
              definitionsNotLoadedTokens: Math.max(0, catalogTokens - describedTokens),
            };
            const record: MeterRecord = {
              runId: run.runId,
              project: run.project,
              level,
              estimated: true,
              tokenizer: tokenizer.name,
              ...counts,
              estimatedSavingTokens: estimatedSaving(counts),
              ...(level === "detailed" ? { calls: [...calls] } : {}),
              ...(options.labels ? { labels: options.labels } : {}),
            };
            await options.sink.write(record);
            return record;
          } catch {
            return undefined;
          }
        },
      };
    },
  };
}
