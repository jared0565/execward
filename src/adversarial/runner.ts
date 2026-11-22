/**
 * Runs adversarial cases against a target and summarises the outcome.
 */
import { ADVERSARIAL_CASES, THREAT_ROWS } from "./cases";
import type { AdversarialCase, CaseResult, Target } from "./types";

/** Cases run one at a time: some set a value in the host environment while they run. */
export async function runSuite(
  target: Target,
  cases: readonly AdversarialCase[] = ADVERSARIAL_CASES,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const item of cases) {
    let outcome;
    try {
      outcome = await item.run(target);
    } catch (error) {
      // A crash is not a defence: nothing shows the attack was stopped.
      const message = error instanceof Error ? error.message : String(error);
      outcome = { defended: false, detail: `The target threw: ${message}` };
    }
    results.push({ id: item.id, kind: item.kind, threats: item.threats, ...outcome });
  }
  return results;
}

export interface SuiteSummary {
  readonly attacks: number;
  readonly attacksDefended: number;
  readonly controls: number;
  readonly controlsServed: number;
}

export function summarise(results: readonly CaseResult[]): SuiteSummary {
  const attacks = results.filter((result) => result.kind === "attack");
  const controls = results.filter((result) => result.kind === "control");
  return {
    attacks: attacks.length,
    attacksDefended: attacks.filter((result) => result.defended).length,
    controls: controls.length,
    controlsServed: controls.filter((result) => result.defended).length,
  };
}

/** Threat-table rows that no attack case covers. Empty when coverage is complete. */
export function uncoveredThreats(cases: readonly AdversarialCase[] = ADVERSARIAL_CASES): number[] {
  const covered = new Set(cases.filter((item) => item.kind === "attack").flatMap((item) => item.threats));
  const missing: number[] = [];
  for (let row = 1; row <= THREAT_ROWS; row++) {
    if (!covered.has(row)) missing.push(row);
  }
  return missing;
}
