/**
 * Contracts 1 and 2: the `code` tool's input and output.
 */
import { z } from "zod";
import { SCRIPT_LIMITS } from "../limits";
import { errorSchema } from "./errors";

/** Contract 1: what a client sends. Unknown fields are refused. */
export const codeToolInputSchema = z.strictObject({
  /** JavaScript source with top-level await. */
  script: z.string().min(1).max(SCRIPT_LIMITS.maxScriptBytes),
  /** Project ID. Selects the policy, data class and quotas. */
  project: z.string().min(1).max(128),
  /** What the client model is trying to do. Model-supplied, so never trusted (FR-47). */
  intent: z.string().max(2_000).optional(),
  /** Checks the client model wants applied to the result. Model-supplied. */
  criteria: z.array(z.string().max(500)).max(20).optional(),
});

export type CodeToolInput = z.infer<typeof codeToolInputSchema>;

/** The run report: a factual record returned beside every result (FR-39). */
export const runReportSchema = z.strictObject({
  runId: z.string().min(1),
  /** SHA-256 of the script, as recorded in the audit log (FR-33). */
  scriptHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Calls made, counted per tool path. */
  callsByTool: z.record(z.string(), z.number().int().nonnegative()),
  recordsRead: z.number().int().nonnegative(),
  recordsWritten: z.number().int().nonnegative(),
  errors: z.array(errorSchema),
  retries: z.number().int().nonnegative(),
  assertions: z.strictObject({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  /** Side effects already committed, in order. Empty while only tier-0 tools exist. */
  sideEffects: z.array(z.strictObject({ tool: z.string(), summary: z.string() })),
  verification: z.enum(["passed", "failed", "unreviewed", "not_applicable"]),
  durationMs: z.number().nonnegative(),
});

export type RunReport = z.infer<typeof runReportSchema>;

/** Contract 2: what the server returns. One shape per status. */
export const codeToolOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    /** The script's final value. Marked untrusted for the model (FR-36). */
    result: z.unknown(),
    /** True when the result was cut to fit the size cap (FR-5). */
    truncated: z.boolean(),
    /** Captured `console.log` output (contract 1.2.0). Untrusted, like the result. */
    logs: z.array(z.string()).optional(),
    report: runReportSchema,
  }),
  z.strictObject({
    status: z.literal("paused"),
    /** Identifies the held action in the owner console. Never counts as sign-in (FR-26). */
    escalation_id: z.string().min(1),
    report: runReportSchema,
  }),
  z.strictObject({
    status: z.literal("error"),
    error: errorSchema,
    /** Output captured before the run ended (contract 1.2.0). Untrusted. */
    logs: z.array(z.string()).optional(),
    report: runReportSchema,
  }),
  z.strictObject({
    /** The script never ran: it failed the pre-execution checks or policy. */
    status: z.literal("refused"),
    error: errorSchema,
    report: runReportSchema,
  }),
]);

export type CodeToolOutput = z.infer<typeof codeToolOutputSchema>;
