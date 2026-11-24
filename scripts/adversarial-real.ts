/**
 * Runs the adversarial suite against ExecWard itself (FR-31, Gate 1).
 *
 *   npm run adversarial:real
 *
 * The attacks run inside the deployed test Worker, where the sandbox is
 * Cloudflare's own; deploy it first with `npm run deploy:test-worker` so it
 * holds this code. The one case about the build is judged here, from the
 * repository's files, so run `npm run sbom` first. Exits 1 unless every attack
 * on a part that exists is defended, by the control meant for it, and both
 * controls are served. `npm run adversarial` is the other half: the same suite
 * against a stub with no defences, where every attack must get through.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ADVERSARIAL_CASES, JUDGED_FROM_THE_BUILD, OPEN_UNTIL_LATER, runSuite } from "../src/adversarial";
import { unexpected, type ObservedResult } from "../src/adversarial/expected";
import { buildTarget } from "./build-facts";

function setting(name: string, file: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const path = join(homedir(), ".execward", file);
  if (!existsSync(path)) throw new Error(`set ${name}, or create ${path}`);
  return readFileSync(path, "utf8").trim();
}

const response = await fetch(`${setting("EXECWARD_TEST_URL", "test-worker-url")}/adversarial`, {
  method: "POST",
  headers: { authorization: `Bearer ${setting("EXECWARD_TEST_SECRET", "test-worker-secret")}` },
  body: "{}",
});
if (!response.ok) throw new Error(`the test Worker answered ${response.status}`);
const remote = (await response.json()) as { target: string; results: ObservedResult[] };
const fromBuild: ObservedResult[] = await runSuite(
  buildTarget(),
  ADVERSARIAL_CASES.filter((item) => JUDGED_FROM_THE_BUILD.includes(item.id)),
);
const results = [...remote.results, ...fromBuild];

const missing = ADVERSARIAL_CASES.filter((item) => !results.some((result) => result.id === item.id)).map((item) => `case "${item.id}" was not run`);
const problems = [...unexpected(results), ...missing];

console.log(`Adversarial suite against: ${remote.target}, on Cloudflare`);
console.log("Expected: every attack on a part that exists is defended, and every control served.\n");
for (const result of results) {
  const later = OPEN_UNTIL_LATER[result.id];
  const label = result.kind === "control" ? (result.defended ? "served" : "REFUSED") : result.defended ? "defended" : later ? "not built" : "OPEN";
  const how = later ? `task ${later.task}: ${later.part}` : (result.runs ?? []).map((run) => run.errorCode ?? run.status).join(", ");
  console.log(`  ${label.padEnd(9)}  ${result.id.padEnd(40)}  ${how}`);
}
const attacks = results.filter((result) => result.kind === "attack");
const notBuilt = attacks.filter((result) => !result.defended && OPEN_UNTIL_LATER[result.id]).length;
console.log(
  `\n${attacks.length} attacks: ${attacks.filter((result) => result.defended).length} defended, ${notBuilt} on parts not built yet, ${attacks.length - attacks.filter((result) => result.defended).length - notBuilt} open. ` +
    `${results.filter((result) => result.kind === "control" && result.defended).length} of ${results.filter((result) => result.kind === "control").length} controls served.`,
);
if (problems.length > 0) {
  console.error("\nNOT as expected:");
  for (const problem of problems) console.error(`  ${problem}`);
} else {
  console.log("As expected.");
}
process.exitCode = problems.length === 0 ? 0 : 1;
