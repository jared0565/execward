/**
 * Runs the adversarial suite (FR-31) and checks the outcome against what is
 * expected of the target.
 *
 *   npm run adversarial            the stub: every attack must be reported open
 *   npm run adversarial -- --json  the same, with one JSON document on stdout
 *
 * Only the stub exists until Phase 1. It has no defences, so the expected
 * outcome is that every attack is NOT defended and every control is served. An
 * attack reported as defended against the stub means that case cannot tell a
 * defence from its absence, and the run fails. When the real server arrives it
 * is added here as a second target, with the opposite expectation.
 */
import { ADVERSARIAL_CASES, runSuite, stubTarget, summarise, uncoveredThreats } from "../src/adversarial";

const json = process.argv.includes("--json");

const target = stubTarget();
const results = await runSuite(target);
const summary = summarise(results);
const uncovered = uncoveredThreats();

const titles = new Map(ADVERSARIAL_CASES.map((item) => [item.id, item.title]));
const wrong = results.filter((result) => (result.kind === "attack" ? result.defended : !result.defended));
const ok = wrong.length === 0 && uncovered.length === 0;

if (json) {
  console.log(JSON.stringify({ target: target.name, ok, summary, uncovered, results }, null, 2));
} else {
  console.log(`Adversarial suite against: ${target.name}`);
  console.log(`Expected: every attack open, every control served.\n`);
  for (const result of results) {
    const expected = result.kind === "attack" ? !result.defended : result.defended;
    const label = result.kind === "attack" ? (result.defended ? "DEFENDED" : "open") : result.defended ? "served" : "REFUSED";
    console.log(`${expected ? "  ok  " : " WRONG"}  ${label.padEnd(8)}  ${result.id}`);
    if (!expected) console.log(`          ${titles.get(result.id) ?? ""}\n          ${result.detail}`);
  }
  console.log(
    `\n${summary.attacks} attacks, ${summary.attacksDefended} defended; ${summary.controls} controls, ${summary.controlsServed} served.`,
  );
  if (uncovered.length > 0) console.log(`Threat-table rows with no case: ${uncovered.join(", ")}`);
  console.log(ok ? "As expected." : "NOT as expected.");
}

process.exitCode = ok ? 0 : 1;
