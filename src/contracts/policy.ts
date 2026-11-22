/**
 * Contract 4: the policy record, one per wrapped tool.
 */
import { z } from "zod";

/** Ordered from least to most sensitive. */
export const DATA_CLASSES = ["public", "internal", "confidential", "client_personal"] as const;
export const dataClassSchema = z.enum(DATA_CLASSES);
export type DataClass = z.infer<typeof dataClassSchema>;

/** Who may call a tool (FR-6). */
export const callerRuleSchema = z.enum(["direct", "script", "both"]);
export type CallerRule = z.infer<typeof callerRuleSchema>;

/** 0 = read-only, 1 = reversible write through the dry run, 2 = needs approval. */
export const tierSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type Tier = z.infer<typeof tierSchema>;

export const policyRecordSchema = z.strictObject({
  server: z.string().min(1),
  tool: z.string().min(1),
  /** SHA-256 of the pinned tool definition (FR-22). */
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  callerRule: callerRuleSchema,
  dataClass: dataClassSchema,
  tier: tierSchema,
  /** Reads data that must not leave the project (FR-29). */
  sensitive: z.boolean(),
  /** Can send data outside: email, public post, external write (FR-29). */
  outbound: z.boolean(),
  /** Destinations an outbound tool may reach. Starts empty. */
  destinationAllowlist: z.array(z.string().min(1)),
  /** Per-tool quotas. Omitted values fall back to the project quotas. */
  quotas: z.strictObject({
    callsPerRun: z.number().int().positive().optional(),
    callsPerDay: z.number().int().positive().optional(),
  }),
});

export type PolicyRecord = z.infer<typeof policyRecordSchema>;

/**
 * Default deny (FR-50): what the broker assumes for a tool with no record.
 * Highest data class, tier 2, direct-only, so a script can never call it.
 */
export const UNCLASSIFIED_TOOL_POLICY = {
  callerRule: "direct",
  dataClass: "client_personal",
  tier: 2,
  sensitive: true,
  outbound: true,
} as const satisfies Pick<
  PolicyRecord,
  "callerRule" | "dataClass" | "tier" | "sensitive" | "outbound"
>;

export function scriptMayCall(record: Pick<PolicyRecord, "callerRule">): boolean {
  return record.callerRule === "script" || record.callerRule === "both";
}
