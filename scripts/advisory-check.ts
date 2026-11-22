/**
 * The weekly advisory check (task 1.1.4).
 *
 *   npm audit --json > audit.json
 *   npx tsx scripts/advisory-check.ts audit.json
 *
 * Prints the report, and appends it to the job summary when run in GitHub
 * Actions. With FILE_ISSUES=true it opens one issue per critical advisory,
 * carrying the 72-hour deadline; an advisory that already has an issue is left
 * alone, so its deadline does not move. Exits 1 when a critical advisory exists
 * or the audit report cannot be read.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  issueBody,
  issueTitle,
  parseNpmAudit,
  renderAdvisoryReport,
  type Advisory,
} from "../src/supply-chain/advisories";

const path = process.argv[2];
if (!path) {
  console.error("Usage: advisory-check.ts <npm-audit-report.json>");
  process.exit(1);
}

const now = new Date();
let advisories: Advisory[];
try {
  advisories = parseNpmAudit(JSON.parse(readFileSync(path, "utf8")) as unknown);
} catch (error) {
  // Not being able to check is a failure, never a clean result.
  console.error(`Advisory check could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const report = renderAdvisoryReport(advisories, now);
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);

const critical = advisories.filter((item) => item.severity === "critical");

if (process.env.FILE_ISSUES === "true") {
  for (const advisory of critical) {
    const title = issueTitle(advisory);
    const existing = JSON.parse(
      execFileSync("gh", ["issue", "list", "--state", "all", "--search", `"${title}" in:title`, "--json", "title"], {
        encoding: "utf8",
      }),
    ) as { title: string }[];
    if (existing.some((issue) => issue.title === title)) {
      console.log(`Issue already filed: ${title}`);
      continue;
    }
    execFileSync("gh", ["issue", "create", "--title", title, "--body", issueBody(advisory, now)], { stdio: "inherit" });
  }
}

if (critical.length > 0) {
  console.error(`${critical.length} critical advisory(ies): patch within 72 hours.`);
  process.exitCode = 1;
}
