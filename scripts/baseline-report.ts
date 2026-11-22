/**
 * Prints the baseline tables for one or more result files. Makes no model call.
 *
 *   npx tsx scripts/baseline-report.ts eval-results/baseline.jsonl [more.jsonl]
 */
import { readFileSync } from "node:fs";
import { renderReport, type ReportRow } from "../src/eval/report";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Give at least one results file.");
  process.exitCode = 1;
} else {
  const rows = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ReportRow),
  );
  console.log(renderReport(rows));
}
