/**
 * Recording what a project's client has asked for, from the owner's console (task G.13).
 *
 * The client notice tells a client they can ask that AI tools are not used on their work,
 * or that they see less. Until a client has a page of their own, the owner records the
 * request here. The service enforces it (src/service.ts); this file only writes it down,
 * for the signed-in owner, with a reason, and puts the change in the audit log.
 */
import type { AuditLog } from "../audit/log";
import { checkClientChoice, type ClientChoice, type ProjectRecord } from "../broker/exposure";
import { DATA_CLASSES } from "../contracts/policy";
import { ConsoleChangeError, requireOwner, type Principal } from "./console";

export interface ClientChoiceStore {
  get(project: string): Promise<ProjectRecord | undefined>;
  list(): Promise<readonly ProjectRecord[]>;
  /** Writes the choice, or clears it when `undefined`. `false` when the project has no record. */
  setChoice(project: string, choice: ClientChoice | undefined): Promise<boolean>;
}

export interface ClientChoiceDeps {
  readonly store: ClientChoiceStore;
  readonly audit: AuditLog;
  readonly now: () => number;
  readonly twoFactorMaxAgeMs?: number;
}

export interface ClientChoices {
  /** Every project with a record, with its client's choice where one is recorded. */
  list(principal: Principal): Promise<readonly ProjectRecord[]>;
  /** Records a client's choice for a project that has a record. `undefined` clears it. */
  set(principal: Principal, project: string, choice: ClientChoice | undefined, reason: string): Promise<ProjectRecord>;
}

const same = (a: ClientChoice | undefined, b: ClientChoice | undefined): boolean => a?.aiUse === b?.aiUse && a?.limit === b?.limit;

/** How much a choice leaves AI tools to do: nothing for "off", up to its limit otherwise, everything with no limit. */
const room = (choice: ClientChoice | undefined): number => {
  if (choice === undefined) return Infinity;
  if (choice.aiUse === "off") return -1;
  return choice.limit === undefined ? Infinity : DATA_CLASSES.indexOf(choice.limit);
};

export function clientChoices(deps: ClientChoiceDeps): ClientChoices {
  const authorised = (principal: Principal): string => {
    requireOwner(principal, deps.now(), deps.twoFactorMaxAgeMs);
    return principal.id;
  };
  return {
    async list(principal) {
      authorised(principal);
      return deps.store.list();
    },

    async set(principal, project, choice, reason) {
      const by = authorised(principal);
      const why = reason.trim().slice(0, 500);
      // The reason is where the owner says who asked and when. A choice with no reason is not recorded.
      if (why === "") throw new ConsoleChangeError("a reason is required: say who asked, and when");
      if (choice !== undefined) {
        try {
          checkClientChoice(choice);
        } catch (error) {
          throw new ConsoleChangeError(error instanceof Error ? error.message : "that is not a choice");
        }
      }
      const before = await deps.store.get(project);
      // The name is the owner's own typing. It is not repeated, in case it was typed into the wrong field.
      if (before === undefined) throw new ConsoleChangeError("that project has no record here, so nothing was changed. Use the project's exact name");
      // Nothing to change: no write, no log entry.
      if (same(before.clientChoice, choice)) return before;
      const after: ProjectRecord = { project, dataClass: before.dataClass, ...(choice === undefined ? {} : { clientChoice: choice }) };
      const record = (): Promise<unknown> =>
        deps.audit.record({
          kind: "console_change",
          runId: "none",
          project,
          body: { action: "set_client_choice", by, reason: why, before: before.clientChoice ?? null, after: choice ?? null },
        });
      const gone = "that project has no record here, so nothing was changed. Use the project's exact name";
      if (room(choice) > room(before.clientChoice)) {
        // Lifting a restriction: on record first, and not done at all if it cannot be recorded.
        // Otherwise AI use could come back on a client's work with nothing to show who lifted it.
        try {
          await record();
        } catch {
          throw new ConsoleChangeError("nothing was changed: the audit log could not be written, and a client's restriction is not lifted without a record");
        }
        if (!(await deps.store.setChoice(project, choice))) throw new ConsoleChangeError(gone);
        return after;
      }
      if (!(await deps.store.setChoice(project, choice))) throw new ConsoleChangeError(gone);
      try {
        await record();
      } catch {
        // A tighter choice stands: a client's request must take effect even when the log does not. It is reported.
        throw new ConsoleChangeError("the choice was recorded but could not be written to the audit log");
      }
      return after;
    },
  };
}
