/**
 * The first golden tasks (task 0.2.4, FR-45): a small set with known answers that
 * a healthy model should pass every time. They are meant to run daily on every
 * model in use (task 2.2.4), where a failure removes that model as a default, so
 * each one has to be cheap, cover a different tool and be passed reliably.
 *
 * They are chosen from the eval suite by id. The evidence for the choice is in
 * docs/decisions/0.2.4-golden-tasks.md.
 */
import type { World } from "../fixtures/world";
import type { EvalTask } from "../types";
import { buildGithubTasks } from "./github-tasks";

export const GOLDEN_TASK_IDS = [
  "dashboard-version", // get_file_contents
  "latest-release-date-dashboard", // list_releases
  "refund-window", // search_code
  "retries-sum", // search_code across repositories, then arithmetic
  "failed-pr-runs-dashboard", // list_workflow_runs with filters
  "public-repo", // get_repository, three times
  "last-merged-pull-author", // list_pull_requests, then a comparison of dates
  "closed-bugs-billing", // list_issues with filters, pull requests excluded
  "pull-additions-billing", // get_pull_request or list_pull_request_files
] as const;

export function buildGoldenTasks(world: World): EvalTask[] {
  const suite = buildGithubTasks(world);
  return GOLDEN_TASK_IDS.map((id) => {
    const task = suite.find((candidate) => candidate.id === id);
    if (task === undefined) throw new Error(`golden task ${id} is not in the suite`);
    return task;
  });
}
