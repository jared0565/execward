/**
 * Connects the GitHub tools to a deployment (task 2.1.10): writes each
 * read-only GitHub tool's policy record, creates or updates one project, and
 * records what was done in the audit log.
 *
 * It is run from the owner's computer through Wrangler, so it needs control of
 * the Cloudflare account, as the emergency stop does. It adds nothing but the
 * tools this build pins, each with the definition hash this build approves; a
 * record changed behind its back is put back to that.
 *
 * It switches nothing on. Code Mode stays as the owner left it.
 */
import type { AuditLog } from "../audit/log";
import { checkProjectRecord, type ProjectRecord } from "../broker/exposure";
import { githubPinsAndPolicy } from "../connectors/github";
import type { DataClass, PolicyRecord } from "../contracts/policy";

/** Who the audit log names. Not a person: whoever held the Cloudflare account at the time. */
export const SETUP_ACTOR = "setup:cloudflare-account";

const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export interface GithubSetupDeps {
  readonly putPolicy: (record: PolicyRecord) => Promise<void>;
  readonly putProject: (record: ProjectRecord) => Promise<void>;
  readonly audit: AuditLog;
}

export interface GithubSetupResult {
  readonly tools: readonly string[];
  readonly project: ProjectRecord;
}

export async function setupGithub(deps: GithubSetupDeps, wanted: { readonly project: string; readonly dataClass: DataClass }): Promise<GithubSetupResult> {
  if (!PROJECT_NAME.test(wanted.project)) throw new Error("the project name must be lower-case letters, digits, dots, dashes or underscores");
  const project: ProjectRecord = { project: wanted.project, dataClass: wanted.dataClass };
  // Refused before anything is written: a class the gate does not allow yet.
  checkProjectRecord(project);
  const { records } = await githubPinsAndPolicy();
  // Every tool here must be one that only reads. Anything else is a fault in this build, not something to store.
  for (const record of records) if (record.tier !== 0 || record.outbound) throw new Error(`"${record.tool}" is not a read-only tool`);

  // The audit entry first: if it cannot be written, nothing is changed.
  const tools = records.map((record) => `${record.server}.${record.tool}`).sort();
  await deps.audit.record({
    kind: "console_change",
    runId: "none",
    project: project.project,
    body: { action: "github_setup", by: SETUP_ACTOR, tools, definitionHashes: Object.fromEntries(records.map((record) => [record.tool, record.definitionHash])), project },
  });
  for (const record of records) await deps.putPolicy(record);
  await deps.putProject(project);
  return { tools, project };
}
