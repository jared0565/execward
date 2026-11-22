import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CRITICAL_PATCH_WINDOW_HOURS,
  issueBody,
  issueTitle,
  parseNpmAudit,
  patchDeadline,
  renderAdvisoryReport,
} from "../src/supply-chain/advisories";

const FOUND = new Date("2026-11-23T06:17:00Z");

/** The shape `npm audit --json` writes, cut down. */
function audit(): Record<string, unknown> {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "left-pad": {
        name: "left-pad",
        severity: "critical",
        via: [
          {
            source: 1,
            name: "left-pad",
            title: "Remote code execution in left-pad",
            url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
            severity: "critical",
          },
        ],
        fixAvailable: true,
      },
      "uses-left-pad": {
        name: "uses-left-pad",
        severity: "critical",
        // Arrives through another package: a string, not an advisory of its own.
        via: ["left-pad"],
        fixAvailable: true,
      },
      slowlib: {
        name: "slowlib",
        severity: "moderate",
        via: [
          {
            source: 2,
            name: "slowlib",
            title: "Slow regular expression",
            url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
            severity: "moderate",
          },
        ],
        fixAvailable: false,
      },
    },
    metadata: { vulnerabilities: { critical: 2, moderate: 1, total: 3 } },
  };
}

const CLEAN = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };

describe("parseNpmAudit", () => {
  it("lists each advisory once, worst first", () => {
    const advisories = parseNpmAudit(audit());
    expect(advisories.map((item) => `${item.severity} ${item.package} ${item.id}`)).toEqual([
      "critical left-pad GHSA-aaaa-bbbb-cccc",
      "moderate slowlib GHSA-dddd-eeee-ffff",
    ]);
    expect(advisories[1]?.fixAvailable).toBe(false);
  });

  it("returns nothing for a clean report", () => {
    expect(parseNpmAudit(CLEAN)).toEqual([]);
  });

  it("throws on a failed audit, so it is never read as clean", () => {
    expect(() => parseNpmAudit({ error: { code: "ENOTFOUND", summary: "request failed" } })).toThrow("npm audit failed");
    expect(() => parseNpmAudit({})).toThrow("no vulnerabilities or metadata");
    expect(() => parseNpmAudit(null)).toThrow("not a JSON object");
    expect(() => parseNpmAudit("")).toThrow("not a JSON object");
  });

  it("treats an unknown severity as critical", () => {
    const report = audit();
    const entry = (report.vulnerabilities as Record<string, { via: Record<string, unknown>[] }>).slowlib;
    if (entry?.via[0]) entry.via[0].severity = "catastrophic";
    expect(parseNpmAudit(report).map((item) => item.severity)).toEqual(["critical", "critical"]);
  });
});

describe("the 72-hour window", () => {
  it("is 72 hours", () => {
    expect(CRITICAL_PATCH_WINDOW_HOURS).toBe(72);
    expect(patchDeadline(FOUND).toISOString()).toBe("2026-11-26T06:17:00.000Z");
  });

  it("puts the deadline on a critical advisory and not on the others", () => {
    const report = renderAdvisoryReport(parseNpmAudit(audit()), FOUND);
    expect(report).toContain("2 known: 1 critical, 1 moderate.");
    expect(report).toMatch(/\| critical \| left-pad \|.*\| yes \| 2026-11-26 06:17 UTC \|/);
    expect(report).toMatch(/\| moderate \| slowlib \|.*\| no \| Next weekly check \|/);
  });

  it("says so plainly when there is nothing", () => {
    expect(renderAdvisoryReport([], FOUND)).toContain("No known advisories in the pinned dependencies.");
  });

  it("writes an issue with a stable title and the deadline", () => {
    const [critical] = parseNpmAudit(audit());
    if (!critical) throw new Error("expected a critical advisory");
    expect(issueTitle(critical)).toBe("Critical advisory in left-pad: GHSA-aaaa-bbbb-cccc");
    const body = issueBody(critical, FOUND);
    expect(body).toContain("Found by the weekly check: 2026-11-23 06:17 UTC");
    expect(body).toContain("Patch by: 2026-11-26 06:17 UTC");
  });
});

describe("the workflow (task 1.1.4)", () => {
  const workflow = readFileSync(".github/workflows/advisories.yml", "utf8");

  it("runs weekly and on demand", () => {
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron: "\d+ \d+ \* \* [0-6]"/);
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("checks the installed, pinned tree and lets the script judge the result", () => {
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm audit --json > audit.json || true");
    expect(workflow).toContain("npx tsx scripts/advisory-check.ts audit.json");
  });

  it("can open issues and nothing more", () => {
    expect(workflow).toContain("issues: write");
    expect(workflow).not.toMatch(/contents: write|pull-requests: write|actions: write/);
  });
});
