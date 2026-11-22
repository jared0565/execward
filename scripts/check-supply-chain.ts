/**
 * Supply-chain gate (FR-23, task 1.1.3). Fails when a dependency is not pinned,
 * the lockfile is missing or out of step, or a CI action is not pinned to a
 * commit. With `--sbom <file>` it also checks that SBOM against package.json.
 *
 *   npm run check:supply-chain
 *   npm run check:supply-chain -- --sbom sbom.cdx.json
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  lockfileProblems,
  sbomProblems,
  unpinnedActions,
  unpinnedDependencies,
  type PackageManifest,
} from "../src/supply-chain/pins";

function readJson(path: string): unknown {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null;
}

const manifest = readJson("package.json") as PackageManifest;
const problems: string[] = [
  ...unpinnedDependencies(manifest),
  ...lockfileProblems(manifest, readJson("package-lock.json")),
];

const workflowDir = join(".github", "workflows");
const workflows = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))
  : [];
for (const file of workflows) {
  for (const problem of unpinnedActions(readFileSync(join(workflowDir, file), "utf8"))) {
    problems.push(`${file}: ${problem}`);
  }
}

const sbomFlag = process.argv.indexOf("--sbom");
const sbomPath = sbomFlag === -1 ? undefined : process.argv[sbomFlag + 1];
if (sbomFlag !== -1) {
  if (!sbomPath) {
    problems.push("--sbom needs a file path");
  } else {
    for (const problem of sbomProblems(manifest, readJson(sbomPath))) problems.push(`${sbomPath}: ${problem}`);
  }
}

if (problems.length > 0) {
  console.error(`Supply-chain check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  const checked = [
    "dependencies pinned",
    "lockfile in step with content hashes",
    `${workflows.length} workflow file(s) pinned to commits`,
    ...(sbomPath ? [`SBOM ${sbomPath} matches`] : []),
  ];
  console.log(`Supply-chain check passed: ${checked.join("; ")}.`);
}
