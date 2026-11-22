/**
 * The weekly advisory check (FR-23, task 1.1.4; Governance: vulnerability intake).
 *
 * Reads the report `npm audit --json` writes, lists the known flaws in the
 * pinned dependencies, and gives each critical one a deadline 72 hours after it
 * was found.
 */

export const SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Hours allowed to patch a critical advisory, counted from when the check found it (FR-23). */
export const CRITICAL_PATCH_WINDOW_HOURS = 72;

export interface Advisory {
  /** The package the flaw is in. */
  readonly package: string;
  readonly severity: Severity;
  readonly title: string;
  /** The advisory's own identifier, for example GHSA-xxxx-xxxx-xxxx. */
  readonly id: string;
  readonly url: string;
  /** True when npm knows a version that fixes it. */
  readonly fixAvailable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/**
 * Advisories in an `npm audit --json` report, worst first.
 *
 * Throws when the report is not one: an audit that failed (no network, a
 * registry error) must never be read as "no advisories".
 */
export function parseNpmAudit(report: unknown): Advisory[] {
  if (!isRecord(report)) throw new Error("the audit report is not a JSON object");
  if ("error" in report) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  if (!isRecord(report.vulnerabilities) || !isRecord(report.metadata)) {
    throw new Error("the audit report has no vulnerabilities or metadata section");
  }

  const found = new Map<string, Advisory>();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (!isRecord(entry) || !Array.isArray(entry.via)) continue;
    for (const via of entry.via) {
      // A string names another package the flaw arrives through; that package has its own entry.
      if (!isRecord(via) || typeof via.url !== "string") continue;
      const id = via.url.split("/").filter(Boolean).pop() ?? via.url;
      const packageName = typeof via.name === "string" ? via.name : name;
      found.set(`${packageName}|${id}`, {
        package: packageName,
        severity: isSeverity(via.severity) ? via.severity : "critical",
        title: typeof via.title === "string" ? via.title : "No title given",
        id,
        url: via.url,
        fixAvailable: entry.fixAvailable !== false,
      });
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );
}

/** When a critical advisory found at `foundAt` must be patched by. */
export function patchDeadline(foundAt: Date): Date {
  return new Date(foundAt.getTime() + CRITICAL_PATCH_WINDOW_HOURS * 60 * 60 * 1000);
}

function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The title of the issue filed for a critical advisory. Stable, so a rerun finds it. */
export function issueTitle(advisory: Advisory): string {
  return `Critical advisory in ${advisory.package}: ${advisory.id}`;
}

export function issueBody(advisory: Advisory, foundAt: Date): string {
  return [
    `**${advisory.title}**`,
    "",
    `- Package: \`${advisory.package}\``,
    `- Advisory: ${advisory.url}`,
    `- Found by the weekly check: ${utc(foundAt)}`,
    `- **Patch by: ${utc(patchDeadline(foundAt))}** (${CRITICAL_PATCH_WINDOW_HOURS} hours, FR-23)`,
    `- Fix available from npm: ${advisory.fixAvailable ? "yes" : "no"}`,
    "",
    "If no fix exists, remove or replace the package, or record why the flaw cannot be reached, before the deadline.",
  ].join("\n");
}

/** The check's log entry, as Markdown. */
export function renderAdvisoryReport(advisories: readonly Advisory[], checkedAt: Date): string {
  const lines = [`## Advisory check, ${utc(checkedAt)}`, ""];
  if (advisories.length === 0) {
    lines.push("No known advisories in the pinned dependencies.");
    return lines.join("\n") + "\n";
  }
  const counts = SEVERITIES.map((severity) => [severity, advisories.filter((item) => item.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);
  lines.push(`${advisories.length} known: ${counts.join(", ")}.`, "");
  lines.push("| Severity | Package | Advisory | Fix available | Patch by |", "|---|---|---|---|---|");
  for (const item of advisories) {
    const deadline = item.severity === "critical" ? utc(patchDeadline(checkedAt)) : "Next weekly check";
    lines.push(
      `| ${item.severity} | ${item.package} | [${item.id}](${item.url}) ${item.title} | ${item.fixAvailable ? "yes" : "no"} | ${deadline} |`,
    );
  }
  return lines.join("\n") + "\n";
}
