/**
 * Types for the adversarial suite (FR-31, tasks 0.3.1 to 0.3.3).
 *
 * A case attacks a `Target` and reports whether the attack was stopped. The
 * target is whatever is under test: the defenceless stub now, the real server
 * from Phase 1. A target exposes probes; a case uses the probes it needs. A
 * target that lacks a probe cannot show the defence, so the case counts as not
 * defended.
 */
import type { ErrorCode } from "../contracts/errors";
import type { PolicyRecord } from "../contracts/policy";

/** JSON Schema, as a tool definition carries it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The policy fields a fixture sets. The target derives the definition hash itself. */
export type FixturePolicy = Pick<
  PolicyRecord,
  "callerRule" | "dataClass" | "tier" | "sensitive" | "outbound" | "destinationAllowlist"
> & { readonly callsPerRun?: number };

/** One upstream tool offered to the target for a script run. */
export interface ToolFixture {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  /** Absent means the tool has no policy record at all (FR-50). */
  readonly policy?: FixturePolicy;
  /** True when a client-side hook guards direct calls to this tool (FR-13). */
  readonly hookGuarded?: boolean;
  /** The upstream itself. The suite counts its calls; the target cannot hide one. */
  handler(args: unknown): unknown;
}

export interface ScriptRun {
  readonly script: string;
  readonly tools: readonly ToolFixture[];
  /** Per-run cap on host calls, when the case sets one. */
  readonly maxHostCalls?: number;
  /** Wall-clock cap in milliseconds, when the case sets one. */
  readonly wallClockMs?: number;
  /**
   * A change made to a tool's definition after it was approved and pinned, and
   * before this run (FR-22).
   */
  readonly redefineAfterApproval?: { readonly path: string; readonly description: string };
}

export interface RunResult {
  readonly status: "completed" | "error" | "refused" | "paused";
  readonly errorCode?: ErrorCode;
  /** The value handed back to the model, on completion. */
  readonly result?: unknown;
  /** True when the result is handed to the model marked as untrusted tool output (FR-36). */
  readonly untrusted?: boolean;
  readonly logs: readonly string[];
}

/** What the suite can ask of the system under test. Every probe is optional. */
export interface Target {
  readonly name: string;

  /** Runs a script through the whole `code` tool path. */
  runScript?(run: ScriptRun): Promise<RunResult>;
  /** The typings and docs a model would be shown for these tools (FR-3, FR-22). */
  typingsFor?(tools: readonly ToolFixture[]): Promise<string>;

  /** Remote sign-in: is a bearer token with this audience and scope accepted (FR-25)? */
  acceptsToken?(token: { readonly audience: string; readonly scopes: readonly string[] }): Promise<boolean>;
  /** Paused runs (FR-26). `resume` answers whether the run continued. */
  pausedRuns?: {
    pause(user: string, project: string): Promise<string>;
    resume(handle: string, user: string): Promise<boolean>;
  };
  /** Approvals (FR-30). `execute` answers whether the call ran. */
  approvals?: {
    request(call: { readonly path: string; readonly args: unknown }): Promise<string>;
    approve(id: string, via: "human_interface" | "model_tool"): Promise<boolean>;
    execute(id: string, call: { readonly path: string; readonly args: unknown }): Promise<boolean>;
  };
  /** Saved scripts (FR-12). `save` answers whether the script was stored. */
  saveScript?(by: "application" | "model", script: string): Promise<boolean>;
  /** The audit log (FR-21, FR-28). */
  auditLog?: {
    /** Records one event and returns the log's lines as stored. */
    record(event: string): Promise<readonly string[]>;
    /** Does the log, given back possibly altered, still verify? */
    verify(lines: readonly string[]): Promise<boolean>;
  };
  /** A request to the local HTTP listener, or `no_listener` when there is none (FR-24). */
  localRequest?(request: { readonly origin: string; readonly token: string | null }): Promise<"served" | "refused" | "no_listener">;
  /** Owner console sign-in (FR-49). Answers whether the session was granted. */
  consoleSignIn?(credentials: { readonly password: string; readonly secondFactor: string | null }): Promise<boolean>;
  /** What the server process can reach (FR-24). */
  processReach?(): Promise<{ readonly shellEnvironment: boolean; readonly filesOutsideProject: boolean }>;
  /** Facts about the build (FR-23). */
  supplyChain?(): Promise<{ readonly lockfile: boolean; readonly exactVersions: boolean; readonly sbom: boolean }>;
  /** The reviewer's verdict on a result, given what a deterministic check found (FR-47, FR-48). */
  review?(input: { readonly resultText: string; readonly deterministicCheckPassed: boolean; readonly tier: 0 | 1 | 2 }): Promise<"passed" | "failed" | "escalated">;
  /** Raises a security exception in one project (FR-44). */
  securityException?(project: string, source: string): Promise<{ readonly pausedProjects: readonly string[]; readonly sourceShown: boolean }>;
}

export interface Verdict {
  /** True when the attack was stopped, or the control held. */
  readonly defended: boolean;
  /** What was observed, in one sentence. Never a secret value. */
  readonly detail: string;
}

export interface AdversarialCase {
  readonly id: string;
  readonly title: string;
  /**
   * Row numbers in the signed-off threat table
   * (docs/decisions/0.1.10-threat-scores.md). Empty for a control case.
   */
  readonly threats: readonly number[];
  /** Requirements whose control this case exercises. */
  readonly requirements: readonly string[];
  /**
   * `attack`: a defenceless target must fail it. `control`: an ordinary request
   * that a working target must serve, so a target cannot pass by refusing everything.
   */
  readonly kind: "attack" | "control";
  run(target: Target): Promise<Verdict>;
}

export interface CaseResult extends Verdict {
  readonly id: string;
  readonly kind: "attack" | "control";
  readonly threats: readonly number[];
}
