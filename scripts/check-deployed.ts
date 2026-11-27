/**
 * Asks Cloudflare what the live production Worker can reach, and compares it
 * with the allowlist (task 1.1.6).
 *
 *   npm run check:deployed
 *
 * Needs a signed-in Wrangler. Reads only: the live version, its bindings and
 * the names of its secrets. It also asks each of the Worker's addresses for its
 * front page with no sign-in, and expects to be turned away. Exits 1 on any
 * difference.
 */
import { execFileSync } from "node:child_process";
import { ALLOWED_ROUTES } from "../src/worker/bindings";
import { deployedProblems, exposureProblems, type AddressProbe, type DeployedBinding } from "../src/worker/deployed-check";

function wrangler(args: readonly string[]): unknown {
  const out = execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"] });
  const start = out.search(/[[{]/);
  if (start === -1) throw new Error(`wrangler ${args[0] ?? ""} printed no JSON`);
  return JSON.parse(out.slice(start));
}

const status = wrangler(["deployments", "status", "--json"]) as { versions?: { version_id: string; percentage: number }[] };
const live = status.versions ?? [];
if (live.length === 0) throw new Error("no version is deployed");

let failed = false;
const secrets = (wrangler(["secret", "list"]) as { name: string }[]).map((secret) => secret.name);
for (const { version_id: id, percentage } of live) {
  const version = wrangler(["versions", "view", id, "--json"]) as { resources?: { bindings?: DeployedBinding[]; script_runtime?: { compatibility_date?: unknown } } };
  const bindings = version.resources?.bindings ?? [];
  const problems = deployedProblems({ bindings, compatibilityDate: version.resources?.script_runtime?.compatibility_date, secrets });
  console.log(`Version ${id} (${percentage}% of traffic): ${bindings.map((binding) => `${binding.name} (${binding.type})`).join(", ") || "no bindings"}; ${secrets.length} secret(s).`);
  for (const problem of problems) console.log(`  PROBLEM: ${problem}`);
  if (problems.length > 0) failed = true;
}
// Who can reach the Worker: each of its addresses must turn away a request with no sign-in.
const probes: AddressProbe[] = [];
for (const { pattern: host } of ALLOWED_ROUTES) {
  try {
    const answer = await fetch(`https://${host}/`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const location = answer.headers.get("location");
    probes.push({ host, status: answer.status, ...(location === null ? {} : { location }) });
  } catch {
    probes.push({ host, status: undefined });
  }
}
const exposed = exposureProblems(probes);
console.log(`Addresses, asked with no sign-in: ${probes.map((probe) => `${probe.host} answered ${probe.status ?? "nothing"}`).join("; ")}.`);
for (const problem of exposed) console.log(`  PROBLEM: ${problem}`);
if (exposed.length > 0) failed = true;
console.log(failed ? "The deployed Worker does not match the allowlist, or an address of it is not guarded." : "The deployed Worker reaches what the allowlist names and nothing else, and both addresses turn away a visitor who has not signed in.");
// Not process.exit: on Windows, leaving while a connection is still closing crashes Node.
process.exitCode = failed ? 1 : 0;
