/**
 * The escalation queue (tasks 1.6.6, 1.6.8, 1.6.9; FR-44, FR-46).
 *
 * One queue holds everything that needs a person. Each item carries the run
 * report and up to four options, built here from a fixed menu per trigger and
 * ranked safest first. One is recommended, by a rule that is shown. A model
 * never writes an option.
 *
 * The safe action is taken at once, when the item is raised: a security
 * exception pauses its project there and then. An item nobody answers by its
 * time limit is closed in its safe state. Nothing is ever approved by default.
 */
import type { AuditLog } from "../audit/log";
import type { Escalation } from "../code-tool/attempts";
import type { RunReport } from "../contracts/code-tool";
import type { ExecWardError } from "../contracts/errors";
import type { CheckedFigure } from "../verify/cross-check";
import { changeControl, ConsoleChangeError, requireOwner, type Principal } from "./console";
import type { ControlStore } from "./control";

export type Trigger = "security_exception" | "definition_changed" | "tier2_action" | "cross_check_disagreement" | "repeated_failure" | "unusual_values";

export interface EscalationOption {
  readonly id: string;
  readonly label: string;
  /** What choosing it does. */
  readonly effect: string;
  readonly reversible: boolean;
  /** A written reason is required to choose it. */
  readonly needsReason?: boolean;
}

/** Facts the recommendation rules read. All optional; a missing fact gets the cautious answer. */
export interface EscalationContext {
  readonly toolPath?: string;
  readonly taskType?: "bounded_tool_heavy" | "exploratory";
  readonly everyCheckPassed?: boolean;
  readonly destinationKnown?: boolean;
  readonly deterministicResultExists?: boolean;
  readonly wordingOnlyAndScanClean?: boolean;
}

interface TriggerSpec {
  /** Safest first. At most four. */
  readonly options: readonly EscalationOption[];
  readonly safeAction: string;
  /** How long an item waits for an answer. `null`: it never expires. */
  readonly expiresAfterMs: number | null;
  /** Urgent items notify at once and are never batched into the digest. */
  readonly urgent: boolean;
  readonly reminderEveryMs: number | null;
  recommend(context: EscalationContext): { readonly optionId: string; readonly rule: string };
}

const HOUR = 60 * 60 * 1000;

/** An approval of a tier-2 action is valid this long; after that, checks re-run before it is applied (FR-46). */
export const APPROVAL_VALID_MS = 15 * 60 * 1000;

/** The PRD's options table and time-limits table, as data. */
export const ESCALATION_MENU: Readonly<Record<Trigger, TriggerSpec>> = {
  security_exception: {
    options: [
      { id: "keep_paused", label: "Keep paused and open the incident runbook", effect: "The project stays paused.", reversible: true },
      { id: "block_tool", label: "Block the tool or server", effect: "The tool is blocked and the project resumes.", reversible: true },
      { id: "revoke_then_resume", label: "Revoke credentials, then resume", effect: "You revoke the credential yourself; the project then resumes.", reversible: false },
      { id: "false_positive", label: "Mark as a false positive and resume", effect: "The project resumes with nothing changed.", reversible: true, needsReason: true },
    ],
    safeAction: "Project paused at once",
    expiresAfterMs: null,
    urgent: true,
    reminderEveryMs: HOUR,
    recommend: () => ({ optionId: "keep_paused", rule: "Keep paused, always. A false positive is never recommended." }),
  },
  definition_changed: {
    options: [
      { id: "block", label: "Block the tool", effect: "The tool stays blocked.", reversible: true },
      { id: "remove_server", label: "Remove the server", effect: "The tool stays blocked; you remove the server yourself.", reversible: false },
      { id: "keep_old_pin", label: "Keep the old pinned version, if the server supports it", effect: "The tool stays blocked until the server offers the pinned version.", reversible: true },
      { id: "approve_new", label: "Approve the new definition after reading the diff", effect: "The tool is unblocked; you approve the new definition yourself.", reversible: true, needsReason: true },
    ],
    safeAction: "Tool blocked at once",
    expiresAfterMs: null,
    urgent: false,
    reminderEveryMs: 24 * HOUR,
    recommend: (context) =>
      context.wordingOnlyAndScanClean === true
        ? { optionId: "approve_new", rule: "The diff only changes wording and passed the scan." }
        : { optionId: "block", rule: "Block, unless the diff only changes wording and passed the scan." },
  },
  tier2_action: {
    options: [
      { id: "reject", label: "Reject", effect: "The action is not taken.", reversible: true },
      { id: "save_draft", label: "Save as a draft or reversible version instead", effect: "A draft is saved; nothing is sent.", reversible: true },
      { id: "approve_with_edits", label: "Approve with edits, re-checked", effect: "The edited action is checked again, then taken.", reversible: false },
      { id: "approve_as_shown", label: "Approve exactly as shown", effect: "The action is taken as shown.", reversible: false },
    ],
    safeAction: "Action held",
    expiresAfterMs: 24 * HOUR,
    urgent: true,
    reminderEveryMs: null,
    recommend: (context) =>
      context.everyCheckPassed === true && context.destinationKnown === true
        ? { optionId: "approve_as_shown", rule: "Every check passed and the destination is known." }
        : { optionId: "save_draft", rule: "Not every check passed, or the destination is not known, so the draft." },
  },
  cross_check_disagreement: {
    options: [
      { id: "discard_both", label: "Discard both results", effect: "Neither result is used.", reversible: true },
      { id: "show_both", label: "Show both figures with how each was computed", effect: "Both figures are handed over, marked as disagreeing.", reversible: true },
      { id: "rerun_stricter", label: "Re-run both with stricter assertions", effect: "Both are run again.", reversible: true },
      { id: "use_deterministic", label: "Use the deterministic result", effect: "The result computed by code is used.", reversible: true },
    ],
    safeAction: "Result held",
    expiresAfterMs: 24 * HOUR,
    urgent: false,
    reminderEveryMs: null,
    recommend: (context) =>
      context.deterministicResultExists === true
        ? { optionId: "use_deterministic", rule: "A deterministic result exists." }
        : { optionId: "rerun_stricter", rule: "No deterministic result exists, so re-run." },
  },
  repeated_failure: {
    options: [
      { id: "stop", label: "Stop", effect: "The run stays stopped.", reversible: true },
      { id: "skip_item", label: "Skip the failing item and continue", effect: "The rest of the task continues without it.", reversible: true },
      { id: "other_model", label: "Retry with a different model family", effect: "The task is tried again with another model.", reversible: true },
      { id: "direct_calls", label: "Retry with direct calls instead of a script", effect: "The task is tried again without Code Mode.", reversible: true },
    ],
    safeAction: "Run stopped",
    expiresAfterMs: 4 * HOUR,
    urgent: false,
    reminderEveryMs: null,
    recommend: (context) =>
      context.taskType === "exploratory"
        ? { optionId: "direct_calls", rule: "Direct calls for exploratory tasks." }
        : context.taskType === "bounded_tool_heavy"
          ? { optionId: "other_model", rule: "A different model for bounded tasks." }
          : { optionId: "stop", rule: "The kind of task is not known, so stop." },
  },
  unusual_values: {
    options: [
      { id: "reject_result", label: "Reject the result", effect: "The result is not used.", reversible: true },
      { id: "rerun_cross_check", label: "Re-run the cross-check", effect: "The figures are checked again.", reversible: true },
      { id: "accept_noted", label: "Accept, with the value range noted", effect: "The result is used, with a note.", reversible: true, needsReason: true },
    ],
    safeAction: "Result held",
    expiresAfterMs: 24 * HOUR,
    urgent: false,
    reminderEveryMs: null,
    recommend: () => ({ optionId: "rerun_cross_check", rule: "Re-run the cross-check." }),
  },
};

export interface EscalationItem {
  readonly id: string;
  readonly trigger: Trigger;
  readonly project: string;
  readonly createdAt: number;
  readonly urgent: boolean;
  readonly status: "open" | "resolved" | "expired";
  readonly runId?: string;
  readonly error?: ExecWardError;
  readonly report?: RunReport;
  readonly context: EscalationContext;
  /** For a cross-check disagreement: every figure the run declared, with both values (FR-43). */
  readonly figures?: readonly CheckedFigure[];
  readonly options: readonly EscalationOption[];
  readonly recommended: { readonly optionId: string; readonly rule: string };
  readonly safeAction: string;
  readonly expiresAt: number | null;
  /** The owner looked and chose to leave it as it is. The item stays open. */
  readonly acknowledgedAt?: number;
  readonly resolution?: { readonly optionId: string; readonly by: string; readonly at: number; readonly reason?: string };
}

export interface EscalationStore {
  put(item: EscalationItem): Promise<void>;
  get(id: string): Promise<EscalationItem | undefined>;
  all(): Promise<EscalationItem[]>;
}

export function memoryEscalationStore(): EscalationStore & { readonly items: Map<string, EscalationItem> } {
  const items = new Map<string, EscalationItem>();
  return { items, put: async (item) => void items.set(item.id, item), get: async (id) => items.get(id), all: async () => [...items.values()] };
}

/** A choice made this often is offered back as a rule. It is never adopted on its own (FR-46). */
export const PROPOSAL_AFTER_CHOICES = 3;

export interface RuleProposal {
  readonly trigger: Trigger;
  readonly optionId: string;
  readonly toolPath?: string;
  readonly timesChosen: number;
  readonly proposal: string;
}

export interface RaiseInput {
  readonly trigger: Trigger;
  readonly project: string;
  readonly runId?: string;
  readonly error?: ExecWardError;
  readonly report?: RunReport;
  readonly context?: EscalationContext;
  readonly figures?: readonly CheckedFigure[];
}

export interface EscalationQueue {
  raise(input: RaiseInput): Promise<EscalationItem>;
  list(principal: Principal): Promise<EscalationItem[]>;
  resolve(principal: Principal, id: string, optionId: string, reason?: string): Promise<EscalationItem>;
  /** Closes items past their time limit, in their safe state. Run on a schedule. */
  expire(): Promise<EscalationItem[]>;
  /** Choices repeated often enough to be offered as rules. Listing them changes nothing. */
  proposals(principal: Principal): Promise<RuleProposal[]>;
}

export interface EscalationDeps {
  readonly store: EscalationStore;
  readonly control: ControlStore;
  readonly audit: AuditLog;
  readonly now: () => number;
  /** Must be random: the ID appears in a link sent by email. */
  readonly newId: () => string;
  /** Told about each new item, for notifications. A failure here never loses the item. */
  readonly onRaised?: (item: EscalationItem) => void | Promise<void>;
}

/** Which trigger a closed task belongs to. `undefined`: it is not a matter for the queue. */
export function triggerFor(escalation: Escalation): Trigger | undefined {
  if (escalation.error.code === "definition_changed") return "definition_changed";
  if (escalation.reason === "security") return "security_exception";
  // A switch the owner threw is not news to the owner.
  if (escalation.error.code === "code_mode_off") return undefined;
  return "repeated_failure";
}

export function escalationQueue(deps: EscalationDeps): EscalationQueue {
  const log = (kind: string, item: EscalationItem, body: Record<string, unknown>): Promise<unknown> =>
    deps.audit
      .record({ kind, runId: item.runId ?? `escalation-${item.id}`, project: item.project, security: item.trigger === "security_exception", body: { escalation: item.id, trigger: item.trigger, ...body } })
      .catch(() => undefined);
  const system = { control: deps.control, audit: deps.audit };

  return {
    async raise(input) {
      const spec = ESCALATION_MENU[input.trigger];
      // One open item per run and trigger: a run that is reported twice is one matter.
      if (input.runId !== undefined) {
        const existing = (await deps.store.all()).find((item) => item.status === "open" && item.runId === input.runId && item.trigger === input.trigger);
        if (existing) return existing;
      }
      const context = input.context ?? {};
      const now = deps.now();
      const item: EscalationItem = {
        id: deps.newId(),
        trigger: input.trigger,
        project: input.project,
        createdAt: now,
        urgent: spec.urgent,
        status: "open",
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.report === undefined ? {} : { report: input.report }),
        ...(input.figures === undefined ? {} : { figures: input.figures }),
        context,
        options: spec.options,
        recommended: spec.recommend(context),
        safeAction: spec.safeAction,
        expiresAt: spec.expiresAfterMs === null ? null : now + spec.expiresAfterMs,
      };

      // The safe action comes first, before the item is even stored: it must not depend on the queue working.
      if (input.trigger === "security_exception") {
        await changeControl(system, { action: "pause_project", by: "execward", reason: `security exception ${item.id}`, project: input.project }, (state) =>
          state.pausedProjects.includes(input.project) ? undefined : { ...state, pausedProjects: [...state.pausedProjects, input.project] },
        );
      }
      const toolPath = context.toolPath;
      if (input.trigger === "definition_changed" && toolPath !== undefined) {
        await changeControl(system, { action: "block_tool", by: "execward", reason: `definition changed, ${item.id}` }, (state) =>
          state.blockedTools.includes(toolPath) ? undefined : { ...state, blockedTools: [...state.blockedTools, toolPath] },
        );
      }

      await deps.store.put(item);
      await log("escalation_raised", item, { safeAction: item.safeAction, recommended: item.recommended.optionId });
      try {
        await deps.onRaised?.(item);
      } catch {
        // The item is in the queue whether or not anyone could be told.
      }
      return item;
    },

    async list(principal) {
      requireOwner(principal, deps.now());
      // Urgent first, then oldest first.
      return (await deps.store.all()).filter((item) => item.status === "open").sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.createdAt - b.createdAt);
    },

    async resolve(principal, id, optionId, reason) {
      requireOwner(principal, deps.now());
      const item = await deps.store.get(id);
      if (item === undefined) throw new ConsoleChangeError("there is no such item");
      if (item.status !== "open") throw new ConsoleChangeError(`this item is already ${item.status}`);
      const option = item.options.find((candidate) => candidate.id === optionId);
      // Only the options the server built can be chosen.
      if (option === undefined) throw new ConsoleChangeError("that is not one of this item's options");
      const why = reason?.trim().slice(0, 500);
      if (option.needsReason === true && (why === undefined || why === "")) throw new ConsoleChangeError("this option needs a written reason");
      const by = principal.id;
      const change = { by, reason: `escalation ${item.id}: ${option.id}`, project: item.project };

      if (item.trigger === "security_exception" && option.id === "keep_paused") {
        const acknowledged: EscalationItem = { ...item, acknowledgedAt: deps.now() };
        await deps.store.put(acknowledged);
        await log("escalation_acknowledged", acknowledged, { by });
        return acknowledged;
      }

      const toolPath = item.context.toolPath;
      if (item.trigger === "security_exception") {
        if (option.id === "block_tool") {
          if (toolPath === undefined) throw new ConsoleChangeError("this item does not name a tool to block");
          await changeControl(system, { ...change, action: "block_tool" }, (state) => (state.blockedTools.includes(toolPath) ? undefined : { ...state, blockedTools: [...state.blockedTools, toolPath] }));
        }
        // Every remaining choice ends the pause.
        await changeControl(system, { ...change, action: "resume_project" }, (state) =>
          state.pausedProjects.includes(item.project) ? { ...state, pausedProjects: state.pausedProjects.filter((project) => project !== item.project) } : undefined,
        );
      }
      if (item.trigger === "definition_changed" && option.id === "approve_new" && toolPath !== undefined) {
        await changeControl(system, { ...change, action: "unblock_tool" }, (state) =>
          state.blockedTools.includes(toolPath) ? { ...state, blockedTools: state.blockedTools.filter((path) => path !== toolPath) } : undefined,
        );
      }

      const resolved: EscalationItem = { ...item, status: "resolved", resolution: { optionId: option.id, by, at: deps.now(), ...(why ? { reason: why } : {}) } };
      await deps.store.put(resolved);
      await log("escalation_resolved", resolved, { optionId: option.id, by, ...(why ? { reason: why } : {}), recommended: item.recommended.optionId });
      return resolved;
    },

    async expire() {
      const now = deps.now();
      const expired: EscalationItem[] = [];
      for (const item of await deps.store.all()) {
        if (item.status !== "open" || item.expiresAt === null || item.expiresAt > now) continue;
        // The safe action was taken when the item was raised. Expiry only closes it, in that state.
        const closed: EscalationItem = { ...item, status: "expired" };
        await deps.store.put(closed);
        await log("escalation_expired", closed, { safeAction: item.safeAction });
        expired.push(closed);
      }
      return expired;
    },

    async proposals(principal) {
      requireOwner(principal, deps.now());
      const counts = new Map<string, RuleProposal>();
      for (const item of await deps.store.all()) {
        if (item.status !== "resolved" || item.resolution === undefined) continue;
        // A security exception is judged each time. It is never turned into a rule.
        if (item.trigger === "security_exception") continue;
        const toolPath = item.context.toolPath;
        const key = `${item.trigger}|${item.resolution.optionId}|${toolPath ?? ""}`;
        const label = item.options.find((option) => option.id === item.resolution?.optionId)?.label ?? item.resolution.optionId;
        const seen = counts.get(key);
        const timesChosen = (seen?.timesChosen ?? 0) + 1;
        counts.set(key, {
          trigger: item.trigger,
          optionId: item.resolution.optionId,
          ...(toolPath === undefined ? {} : { toolPath }),
          timesChosen,
          proposal: `You chose "${label}" ${timesChosen} times${toolPath === undefined ? "" : ` for ${toolPath}`}. Make it a rule?`,
        });
      }
      return [...counts.values()].filter((proposal) => proposal.timesChosen >= PROPOSAL_AFTER_CHOICES);
    },
  };
}

/** Sends a task closed by the code tool to the queue. For `attemptGate`'s `onEscalate`. */
export function escalationHook(queue: EscalationQueue, project: string, context: EscalationContext = {}): (escalation: Escalation) => Promise<void> {
  return async (escalation) => {
    const trigger = triggerFor(escalation);
    if (trigger === undefined) return;
    // Awaited: the project is paused before the reply that caused it is handed over.
    await queue.raise({ trigger, project, runId: escalation.runId, error: escalation.error, context });
  };
}
