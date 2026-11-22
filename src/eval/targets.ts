/**
 * The models the eval measures and the routes to each, in the order they are
 * tried: OpenRouter first, the provider's own API when OpenRouter fails.
 * Decided 2026-11-22, see docs/decisions/0.2.2-eval-harness-and-routes.md.
 */
import { anthropicProvider } from "./providers/anthropic";
import { openAIProvider } from "./providers/openai";
import { openRouterProvider } from "./providers/openrouter";
import type { ModelProvider, RunRecord } from "./types";

export interface Target {
  readonly name: string;
  readonly routes: readonly ModelProvider[];
  /** US dollars per million tokens, from the provider's price page on 2026-11-22. */
  readonly pricePerMTok: { readonly input: number; readonly output: number };
}

/** Every key a run may need. All are required up front, so a fallback cannot fail on a missing key. */
export const REQUIRED_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** The models measured, by name. Known without building a client or reading a key. */
export const BASELINE_TARGET_NAMES = ["Claude Haiku 5.5", "GPT-6 Luna"] as const;

/** Builds the targets. Call only after the keys are known to be present. */
export function baselineTargets(): Target[] {
  return [
    {
      name: BASELINE_TARGET_NAMES[0],
      pricePerMTok: { input: 0.1, output: 0.5 },
      routes: [
        openRouterProvider({ model: "anthropic/claude-haiku-5.5", upstream: "anthropic" }),
        anthropicProvider({ model: "claude-haiku-5-5" }),
      ],
    },
    {
      name: BASELINE_TARGET_NAMES[1],
      pricePerMTok: { input: 0.1, output: 0.5 },
      routes: [
        openRouterProvider({ model: "openai/gpt-6-luna", upstream: "openai" }),
        openAIProvider({ model: "gpt-6-luna" }),
      ],
    },
  ];
}

/** Tokens times list price. Used when the route does not report a cost. */
export function estimatedCostUsd(target: Target, record: RunRecord): number {
  return (
    (record.inputTokens * target.pricePerMTok.input +
      record.outputTokens * target.pricePerMTok.output) /
    1_000_000
  );
}

/** What a run cost: the route's own figure when it gave one, the estimate otherwise. */
export function costUsd(target: Target, record: RunRecord): number {
  return record.reportedCostUsd ?? estimatedCostUsd(target, record);
}
