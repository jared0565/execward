/**
 * A small, invented GitHub organisation for the eval. Everything is generated from
 * a fixed seed, so every run sees the same data and a task's expected answer can
 * be computed from this same data instead of typed by hand. No real person,
 * repository or code appears here.
 */

export interface WorldComment {
  readonly id: number;
  readonly user: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface WorldChange {
  readonly filename: string;
  readonly status: "added" | "modified" | "removed";
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

export interface WorldPull {
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly files: readonly WorldChange[];
}

/** An issue or a pull request: on GitHub they share one number sequence. */
export interface WorldIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly user: string;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly comments: readonly WorldComment[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly pull: WorldPull | null;
}

export interface WorldCommit {
  readonly sha: string;
  readonly author: string;
  readonly date: string;
  readonly message: string;
  readonly files: readonly WorldChange[];
}

export interface WorldFile {
  readonly path: string;
  readonly content: string;
}

export interface WorldRelease {
  readonly id: number;
  readonly tag: string;
  readonly name: string;
  readonly body: string;
  readonly author: string;
  readonly prerelease: boolean;
  readonly publishedAt: string;
}

export interface WorldRun {
  readonly id: number;
  readonly runNumber: number;
  readonly branch: string;
  readonly event: "push" | "pull_request";
  readonly conclusion: "success" | "failure" | "cancelled";
  readonly sha: string;
  readonly actor: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface WorldRepo {
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly private: boolean;
  readonly language: string;
  readonly topics: readonly string[];
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly stars: number;
  readonly branches: readonly { readonly name: string; readonly sha: string }[];
  /** Newest first, all on the default branch. */
  readonly commits: readonly WorldCommit[];
  readonly files: readonly WorldFile[];
  /** Ascending by number. */
  readonly issues: readonly WorldIssue[];
  /** Newest first. */
  readonly releases: readonly WorldRelease[];
  /** Newest first. */
  readonly runs: readonly WorldRun[];
}

export interface World {
  readonly owner: string;
  readonly users: readonly string[];
  readonly labels: readonly { readonly name: string; readonly color: string; readonly description: string }[];
  readonly repos: readonly WorldRepo[];
}

export const WORLD_OWNER = "northwind-labs";
const USERS = ["ana-ruiz", "bo-lindqvist", "chen-wei", "dee-okoro", "eli-marsh", "fay-tanaka", "gus-novak", "hal-ibsen"];
const LABELS = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  { name: "documentation", color: "0075ca", description: "Improvements or additions to documentation" },
  { name: "security", color: "b60205", description: "Security-related change" },
  { name: "performance", color: "fbca04", description: "Speed or resource use" },
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
  { name: "question", color: "d876e3", description: "Further information is requested" },
];

const PROBLEMS = ["times out", "returns a wrong total", "leaks memory", "crashes on empty input", "ignores the rate limit", "logs a secret", "double-counts refunds", "fails on Windows paths"];
const AREAS = ["invoice export", "login flow", "webhook retry", "search index", "CSV import", "audit log", "session cache", "report scheduler"];
const CHANGES = ["Add", "Fix", "Refactor", "Document", "Speed up", "Harden"];
const REPLIES = ["I can reproduce this on main.", "Does this still happen after the last release?", "A fix is in review.", "This looks like a duplicate.", "Adding logs showed nothing unusual.", "Confirmed fixed, thanks."];

const DAY_MS = 86_400_000;
/** The newest moment in the world. Every date is at or before it. */
export const WORLD_NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

/** mulberry32: a tiny seeded generator, enough for repeatable test data. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A stable number from a string, used for ids and hashes. */
export function stableNumber(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash;
}

function fakeSha(seed: string): string {
  let sha = "";
  for (let part = 0; part < 5; part += 1) {
    sha += stableNumber(`${seed}:${part}`).toString(16).padStart(8, "0");
  }
  return sha;
}

function iso(ms: number): string {
  // GitHub timestamps carry whole seconds.
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

interface RepoSpec {
  readonly name: string;
  readonly description: string;
  readonly private: boolean;
  readonly language: string;
  readonly topics: readonly string[];
  readonly stars: number;
  readonly issueCount: number;
  readonly files: readonly WorldFile[];
}

const SPECS: readonly RepoSpec[] = [
  {
    name: "billing-api",
    description: "Invoices, refunds and payment webhooks.",
    private: true,
    language: "TypeScript",
    topics: ["billing", "api"],
    stars: 12,
    issueCount: 48,
    files: [
      { path: "README.md", content: "# billing-api\n\nInvoices, refunds and payment webhooks.\n\nRun `npm test` before every push.\n" },
      { path: "package.json", content: '{\n  "name": "billing-api",\n  "version": "2.4.1",\n  "engines": { "node": ">=22" }\n}\n' },
      { path: "src/invoice.ts", content: "export const TAX_RATE = 0.2;\n\nexport function invoiceTotal(net: number): number {\n  return Math.round(net * (1 + TAX_RATE) * 100) / 100;\n}\n" },
      { path: "src/refund.ts", content: "export const REFUND_WINDOW_DAYS = 30;\n\nexport function canRefund(ageDays: number): boolean {\n  return ageDays <= REFUND_WINDOW_DAYS;\n}\n" },
      { path: "src/webhook.ts", content: "export const MAX_RETRIES = 5;\nexport const RETRY_DELAY_MS = 2000;\n\nexport function shouldRetry(attempt: number): boolean {\n  return attempt < MAX_RETRIES;\n}\n" },
      { path: ".github/workflows/ci.yml", content: "name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci\n      - run: npm test\n" },
    ],
  },
  {
    name: "web-dashboard",
    description: "The customer dashboard.",
    private: true,
    language: "TypeScript",
    topics: ["frontend", "dashboard"],
    stars: 7,
    issueCount: 36,
    files: [
      { path: "README.md", content: "# web-dashboard\n\nThe customer dashboard. Talks to billing-api.\n" },
      { path: "package.json", content: '{\n  "name": "web-dashboard",\n  "version": "5.0.3",\n  "engines": { "node": ">=22" }\n}\n' },
      { path: "src/session.ts", content: "export const SESSION_TTL_MINUTES = 45;\n\nexport function isExpired(ageMinutes: number): boolean {\n  return ageMinutes > SESSION_TTL_MINUTES;\n}\n" },
      { path: "src/api-client.ts", content: "export const API_TIMEOUT_MS = 8000;\nexport const MAX_RETRIES = 3;\n\nexport function baseUrl(): string {\n  return \"https://billing.internal.example\";\n}\n" },
      { path: "docs/deploy.md", content: "# Deploying\n\nDeploys run from the `main` branch after CI passes.\nRoll back with `npm run rollback`.\n" },
    ],
  },
  {
    name: "infra-tools",
    description: "Scripts for backups and log shipping.",
    private: false,
    language: "Python",
    topics: ["ops", "backup"],
    stars: 31,
    issueCount: 24,
    files: [
      { path: "README.md", content: "# infra-tools\n\nScripts for backups and log shipping.\n" },
      { path: "backup.py", content: "RETENTION_DAYS = 14\nMAX_RETRIES = 4\n\n\ndef should_keep(age_days: int) -> bool:\n    return age_days <= RETENTION_DAYS\n" },
      { path: "ship_logs.py", content: "BATCH_SIZE = 500\n\n\ndef batches(lines):\n    for start in range(0, len(lines), BATCH_SIZE):\n        yield lines[start:start + BATCH_SIZE]\n" },
      { path: "requirements.txt", content: "requests==2.32.3\npyyaml==6.0.2\n" },
    ],
  },
];

function buildRepo(spec: RepoSpec): WorldRepo {
  const random = generator(stableNumber(spec.name));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const whole = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));

  const change = (seed: string): WorldChange => {
    const file = pick(spec.files);
    const additions = whole(1, 40);
    const deletions = whole(0, 15);
    return {
      filename: file.path,
      status: "modified",
      additions,
      deletions,
      patch: `@@ -1,${deletions + 2} +1,${additions + 2} @@\n-// before ${seed}\n+// after ${seed}`,
    };
  };

  const issues: WorldIssue[] = [];
  for (let number = 1; number <= spec.issueCount; number += 1) {
    const created = WORLD_NOW - (spec.issueCount - number + 1) * 3 * DAY_MS - whole(0, 2 * DAY_MS);
    const isPull = random() < 0.3;
    const closed = random() < 0.55;
    const closedAtMs = closed ? Math.min(created + whole(1, 20) * DAY_MS, WORLD_NOW) : null;
    const area = pick(AREAS);
    const title = isPull ? `${pick(CHANGES)} ${area}` : `${area[0]?.toUpperCase()}${area.slice(1)} ${pick(PROBLEMS)}`;
    const labels = [...new Set(Array.from({ length: whole(0, 2) }, () => pick(LABELS).name))];
    const comments: WorldComment[] = Array.from({ length: whole(0, 5) }, (_, index) => ({
      id: stableNumber(`${spec.name}#${number}c${index}`),
      user: pick(USERS),
      body: pick(REPLIES),
      createdAt: iso(Math.min(created + (index + 1) * 5 * 3_600_000, WORLD_NOW)),
    }));
    const lastActivity = Math.max(created, closedAtMs ?? 0, ...comments.map((c) => Date.parse(c.createdAt)));
    const merged = isPull && closed && random() < 0.8;
    issues.push({
      number,
      title,
      body: isPull
        ? `This change touches the ${area}.\n\nTested locally with \`npm test\`.`
        : `Seen in production: the ${title.toLowerCase()}.\n\nSteps: open the ${area} and wait.`,
      state: closed ? "closed" : "open",
      user: pick(USERS),
      assignees: random() < 0.5 ? [pick(USERS)] : [],
      labels,
      comments,
      createdAt: iso(created),
      updatedAt: iso(lastActivity),
      closedAt: closedAtMs === null ? null : iso(closedAtMs),
      pull: isPull
        ? {
            head: `feature/${area.replaceAll(" ", "-")}-${number}`,
            base: "main",
            draft: !closed && random() < 0.25,
            merged,
            mergedAt: merged && closedAtMs !== null ? iso(closedAtMs) : null,
            files: Array.from({ length: whole(1, 4) }, (_, index) => change(`pr${number}.${index}`)),
          }
        : null,
    });
  }

  const commits: WorldCommit[] = Array.from({ length: 40 }, (_, index) => {
    const date = WORLD_NOW - index * 2 * DAY_MS - whole(0, DAY_MS);
    return {
      sha: fakeSha(`${spec.name}:commit:${index}`),
      author: pick(USERS),
      date: iso(date),
      message: `${pick(CHANGES)} ${pick(AREAS)}`,
      files: Array.from({ length: whole(1, 3) }, (_, n) => change(`c${index}.${n}`)),
    };
  });

  const releases: WorldRelease[] = Array.from({ length: 6 }, (_, index) => {
    const minor = 5 - index;
    return {
      id: stableNumber(`${spec.name}:release:${minor}`),
      tag: `v1.${minor}.0`,
      name: `Release 1.${minor}.0`,
      body: `Changes in 1.${minor}.0: ${pick(CHANGES).toLowerCase()} ${pick(AREAS)}.`,
      author: pick(USERS),
      prerelease: false,
      publishedAt: iso(WORLD_NOW - (index * 21 + 4) * DAY_MS),
    };
  });

  const openPulls = issues.filter((issue) => issue.pull !== null && issue.state === "open");
  const runs: WorldRun[] = Array.from({ length: 30 }, (_, index) => {
    const started = WORLD_NOW - index * 9 * 3_600_000 - whole(0, 3_600_000);
    const onPull = openPulls.length > 0 && random() < 0.4;
    const roll = random();
    return {
      id: stableNumber(`${spec.name}:run:${index}`),
      runNumber: 30 - index,
      branch: onPull ? (pick(openPulls).pull?.head ?? "main") : "main",
      event: onPull ? "pull_request" : "push",
      conclusion: roll < 0.2 ? "failure" : roll < 0.25 ? "cancelled" : "success",
      sha: pick(commits).sha,
      actor: pick(USERS),
      startedAt: iso(started),
      updatedAt: iso(started + whole(120, 900) * 1000),
    };
  });

  return {
    owner: WORLD_OWNER,
    name: spec.name,
    description: spec.description,
    private: spec.private,
    language: spec.language,
    topics: spec.topics,
    defaultBranch: "main",
    createdAt: iso(WORLD_NOW - 400 * DAY_MS),
    stars: spec.stars,
    branches: [
      { name: "main", sha: commits[0]?.sha ?? fakeSha(spec.name) },
      ...openPulls.map((issue) => ({
        name: issue.pull?.head ?? "",
        sha: fakeSha(`${spec.name}:branch:${issue.number}`),
      })),
    ],
    commits,
    files: spec.files,
    issues,
    releases,
    runs,
  };
}

/** Builds the world. Calling it again gives equal data. */
export function buildWorld(): World {
  return { owner: WORLD_OWNER, users: USERS, labels: LABELS, repos: SPECS.map(buildRepo) };
}
