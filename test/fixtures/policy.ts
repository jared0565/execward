import type { PolicyRecord } from "../../src/contracts/policy";

/** A policy record for a made-up GitHub tool: tier 0 and callable from scripts unless overridden. */
export function record(tool: string, overrides: Partial<PolicyRecord> = {}): PolicyRecord {
  return {
    server: "github",
    tool,
    definitionHash: "a".repeat(64),
    callerRule: "both",
    dataClass: "internal",
    tier: 0,
    sensitive: false,
    outbound: false,
    destinationAllowlist: [],
    quotas: {},
    ...overrides,
  };
}
