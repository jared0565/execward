/**
 * The eval task suite on the fixture GitHub tools (task 0.2.3). Every expected
 * answer is computed from the fixture world, so a task cannot disagree with the
 * data it is asked about.
 *
 * Two types, as the PRD's evaluation plan asks:
 * - bounded tool-heavy: the route is clear and the work is fetching and counting;
 * - exploratory: the model has to find out where to look first.
 */
import type { EvalTask, TaskType } from "../types";
import { AREAS, type World, type WorldIssue, type WorldRepo } from "../fixtures/world";

/** Numbers in an answer, with thousands separators removed. */
function numbersIn(answer: string): number[] {
  return (answer.replaceAll(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Passes when the answer names this number and no other. */
function onlyNumber(expected: number): (answer: string) => boolean {
  return (answer) => {
    const found = numbersIn(answer);
    return found.length > 0 && found.every((value) => value === expected);
  };
}

/** Passes when the numbers in the answer are exactly this set. */
function numberSet(expected: readonly number[]): (answer: string) => boolean {
  return (answer) => {
    const found = new Set(numbersIn(answer));
    return found.size === expected.length && expected.every((value) => found.has(value));
  };
}

/** Passes when the answer names the expected item and none of the other candidates. */
function oneOf(expected: string, candidates: readonly string[]): (answer: string) => boolean {
  return (answer) => {
    const text = answer.toLowerCase();
    return (
      text.includes(expected.toLowerCase()) &&
      candidates.every((other) => other === expected || !text.includes(other.toLowerCase()))
    );
  };
}

function includesAll(...parts: readonly string[]): (answer: string) => boolean {
  return (answer) => parts.every((part) => answer.toLowerCase().includes(part.toLowerCase()));
}

/** The single item with the highest score. Throws on a tie, which would make a task unfair. */
function topBy<T>(items: readonly T[], score: (item: T) => number, what: string): T {
  const ranked = [...items].sort((a, b) => score(b) - score(a));
  const [first, second] = ranked;
  if (first === undefined) throw new Error(`no candidates for ${what}`);
  if (second !== undefined && score(second) === score(first)) throw new Error(`tie for ${what}`);
  return first;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

const isIssue = (issue: WorldIssue): boolean => issue.pull === null;
const isOpen = (issue: WorldIssue): boolean => issue.state === "open";

export function buildGithubTasks(world: World): EvalTask[] {
  const find = (name: string): WorldRepo => {
    const repo = world.repos.find((candidate) => candidate.name === name);
    if (repo === undefined) throw new Error(`fixture repo ${name} is missing`);
    return repo;
  };
  const billing = find("billing-api");
  const dashboard = find("web-dashboard");
  const infra = find("infra-tools");
  const full = (repo: WorldRepo): string => `${repo.owner}/${repo.name}`;
  const everyIssue = world.repos.flatMap((repo) => repo.issues);
  const repoNames = world.repos.map((repo) => repo.name);
  const tasks: EvalTask[] = [];

  const add = (id: string, type: TaskType, prompt: string, expected: string | number, check: (answer: string) => boolean): void => {
    tasks.push({ id, type, prompt, expected: String(expected), check });
  };
  const count = (id: string, type: TaskType, prompt: string, expected: number): void =>
    add(id, type, `${prompt} Reply with the number only.`, expected, onlyNumber(expected));

  // Bounded tool-heavy: the route is clear, the work is fetching and counting.
  const bounded = "bounded_tool_heavy";

  count("open-issues-billing", bounded, `How many open issues does ${full(billing)} have? Count issues only, not pull requests.`,
    billing.issues.filter((issue) => isIssue(issue) && isOpen(issue)).length);

  count("open-issues-org", bounded, `How many open issues are there in total across all three repositories of the ${world.owner} organisation (${repoNames.join(", ")})? Count issues only, not pull requests.`,
    everyIssue.filter((issue) => isIssue(issue) && isOpen(issue)).length);

  count("open-pulls-dashboard", bounded, `How many open pull requests does ${full(dashboard)} have?`,
    dashboard.issues.filter((issue) => !isIssue(issue) && isOpen(issue)).length);

  count("closed-bugs-billing", bounded, `How many closed issues in ${full(billing)} have the label "bug"? Count issues only, not pull requests.`,
    billing.issues.filter((issue) => isIssue(issue) && !isOpen(issue) && issue.labels.includes("bug")).length);

  count("failed-runs-billing", bounded, `How many CI workflow runs in ${full(billing)} ended in failure?`,
    billing.runs.filter((run) => run.conclusion === "failure").length);

  count("merged-pulls-billing", bounded, `How many pull requests in ${full(billing)} have been merged?`,
    billing.issues.filter((issue) => issue.pull?.merged === true).length);

  count("comments-open-issues-infra", bounded, `Add up the comments on all open issues in ${full(infra)} (issues only, not pull requests). What is the total number of comments?`,
    infra.issues.filter((issue) => isIssue(issue) && isOpen(issue)).reduce((total, issue) => total + issue.comments.length, 0));

  count("commits-touching-invoice", bounded, `How many commits in ${full(billing)} changed the file src/invoice.ts?`,
    billing.commits.filter((commit) => commit.files.some((file) => file.filename === "src/invoice.ts")).length);

  count("commit-authors-dashboard", bounded, `How many different people have authored commits on the main branch of ${full(dashboard)}?`,
    new Set(dashboard.commits.map((commit) => commit.author)).size);

  count("open-security-org", bounded, `Across all repositories of the ${world.owner} organisation (${repoNames.join(", ")}), how many open issues or pull requests have the label "security"?`,
    everyIssue.filter((issue) => isOpen(issue) && issue.labels.includes("security")).length);

  count("failed-pr-runs-dashboard", bounded, `How many CI workflow runs in ${full(dashboard)} were triggered by a pull_request event and ended in failure?`,
    dashboard.runs.filter((run) => run.event === "pull_request" && run.conclusion === "failure").length);

  count("draft-pulls-org", bounded, `Across all repositories of the ${world.owner} organisation (${repoNames.join(", ")}), how many open pull requests are drafts?`,
    everyIssue.filter((issue) => isOpen(issue) && issue.pull?.draft === true).length);

  const oldestOpen = billing.issues.find((issue) => isIssue(issue) && isOpen(issue));
  if (oldestOpen === undefined) throw new Error("no open issue in billing-api");
  count("oldest-open-issue-billing", bounded, `What is the number of the oldest open issue in ${full(billing)}? Issues only, not pull requests.`, oldestOpen.number);

  count("uncommented-issues-dashboard", bounded, `How many issues in ${full(dashboard)}, open or closed, have no comments at all? Issues only, not pull requests.`,
    dashboard.issues.filter((issue) => isIssue(issue) && issue.comments.length === 0).length);

  const bigPull = topBy(billing.issues.filter((issue) => !isIssue(issue)), (issue) => (issue.pull?.files.length ?? 0) * 1000 + issue.number, "largest pull request");
  count("pull-additions-billing", bounded, `How many lines does pull request #${bigPull.number} in ${full(billing)} add in total, across all the files it changes?`,
    (bigPull.pull?.files ?? []).reduce((total, file) => total + file.additions, 0));

  const authorCounts = countBy(infra.commits, (commit) => commit.author);
  const topAuthor = topBy([...authorCounts], ([, commits]) => commits, "top commit author")[0];
  add("top-commit-author-infra", bounded, `Who has authored the most commits in ${full(infra)}? Reply with their GitHub login only.`, topAuthor, oneOf(topAuthor, world.users));

  const assigneeCounts = countBy(everyIssue.filter((issue) => isIssue(issue) && isOpen(issue)).flatMap((issue) => issue.assignees), (login) => login);
  // The question names the person, so a tie for busiest is harmless: take the first by login.
  const busiestFirst = [...assigneeCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [busyLogin, busyCount] = busiestFirst[0] ?? ["", 0];
  if (busyCount === 0) throw new Error("no open issue is assigned to anyone");
  count("assigned-open-issues-org", bounded, `Across all repositories of the ${world.owner} organisation (${repoNames.join(", ")}), how many open issues (not pull requests) are assigned to ${busyLogin}?`, busyCount);

  const reporterCounts = countBy(billing.issues.filter(isIssue), (issue) => issue.user);
  const topReporter = topBy([...reporterCounts], ([, issues]) => issues, "top reporter")[0];
  add("top-reporter-billing", bounded, `Who has opened the most issues in ${full(billing)}, counting open and closed issues but not pull requests? Reply with their GitHub login only.`, topReporter, oneOf(topReporter, world.users));

  const latestRelease = dashboard.releases[0];
  if (latestRelease === undefined) throw new Error("no release in web-dashboard");
  const releaseDay = latestRelease.publishedAt.slice(0, 10);
  add("latest-release-date-dashboard", bounded, `On what date was the latest release of ${full(dashboard)} published? Reply with the date as YYYY-MM-DD.`, releaseDay, includesAll(releaseDay));

  const openLabelCounts = countBy(billing.issues.filter((issue) => isIssue(issue) && isOpen(issue)).flatMap((issue) => issue.labels), (name) => name);
  const topLabel = topBy([...openLabelCounts], ([, issues]) => issues, "most common label")[0];
  add("top-label-open-issues-billing", bounded, `Which label appears on the most open issues in ${full(billing)} (issues only, not pull requests)? Reply with the label name only.`, topLabel, oneOf(topLabel, world.labels.map((label) => label.name)));

  // Exploratory: the model has to find out where to look first.
  const exploratory = "exploratory";

  add("session-ttl", exploratory, `Somewhere in the ${world.owner} organisation's code a session time-to-live is defined. Which repository is it in, and how many minutes is it? Reply as "repository: minutes".`,
    "web-dashboard: 45", (answer) => oneOf("web-dashboard", repoNames)(answer) && onlyNumber(45)(answer));

  count("refund-window", exploratory, `The ${world.owner} organisation's code defines how long after purchase a refund is allowed. How many days is it?`, 30);

  add("backup-retention", exploratory, `One of the ${world.owner} repositories keeps backups for a fixed number of days. Which file sets that number, and what is it? Reply as "path: days".`,
    "backup.py: 14", (answer) => includesAll("backup.py")(answer) && onlyNumber(14)(answer));

  count("retries-sum", exploratory, `Several files in the ${world.owner} organisation's repositories define a constant named MAX_RETRIES. What do their values add up to?`, 12);

  const lastFailedOnMain = billing.runs.find((run) => run.branch === "main" && run.conclusion === "failure");
  if (lastFailedOnMain === undefined) throw new Error("no failed run on main in billing-api");
  add("last-failed-main-run-actor", exploratory, `The CI of ${full(billing)} has failed on the main branch at times. Who triggered the most recent of those failed runs? Reply with their GitHub login only.`,
    lastFailedOnMain.actor, oneOf(lastFailedOnMain.actor, world.users));

  const openAbout = (area: string): number[] =>
    billing.issues.filter((issue) => isIssue(issue) && isOpen(issue) && issue.title.toLowerCase().includes(area)).map((issue) => issue.number);
  const area = AREAS.find((candidate) => openAbout(candidate).length >= 2);
  if (area === undefined) throw new Error("no area has two open issues in billing-api");
  add("open-issues-about-area", exploratory, `Which open issues in ${full(billing)} are about the ${area}, going by their titles? Issues only, not pull requests. Reply with the issue numbers only, separated by commas.`,
    openAbout(area).join(", "), numberSet(openAbout(area)));

  const mergedPulls = dashboard.issues.filter((issue) => issue.pull?.merged === true);
  const lastMerged = topBy(mergedPulls, (issue) => Date.parse(issue.pull?.mergedAt ?? ""), "latest merged pull request");
  add("last-merged-pull-author", exploratory, `Who wrote the pull request that was merged most recently in ${full(dashboard)}? Reply with their GitHub login only.`,
    lastMerged.user, oneOf(lastMerged.user, world.users));

  add("public-repo", exploratory, `Exactly one repository of the ${world.owner} organisation (${repoNames.join(", ")}) is public. Which one? Reply with its name only.`,
    "infra-tools", oneOf("infra-tools", repoNames));

  add("dashboard-version", exploratory, `What version of ${full(dashboard)} is currently on its main branch, according to its package manifest? Reply with the version only.`,
    "5.0.3", includesAll("5.0.3"));

  add("rollback-command", exploratory, `How does someone roll back a deploy of ${full(dashboard)}? Reply with the command only.`,
    "npm run rollback", includesAll("npm run rollback"));

  return tasks;
}
