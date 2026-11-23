/**
 * The executor interface: the one seam between ExecWard's core and whatever sandbox
 * runs a model-written script (task 0.1.3).
 *
 * The core depends only on this file. A sandbox is swapped by writing another
 * implementation, never by changing the broker, the policy table or the audit log.
 *
 * Rules every implementation must keep:
 *  1. The script reaches the outside world only through `SandboxHost`. No network,
 *     no environment values, no credentials, no globals beyond the Sandbox API.
 *  2. The executor enforces `ExecutionLimits`. A limit it cannot enforce natively
 *     (wall-clock time on Dynamic Workers, for example) it enforces itself, outside
 *     the script's reach.
 *  3. On any fault it returns `sandbox_fault`. It never falls back to running the
 *     script, or any tool call, outside the sandbox (NFR: failure behaviour).
 *  4. It holds no policy. Whether a call is allowed is the host's decision; the
 *     executor only carries the call and the answer.
 */

/** Limits for one run. Values are set by task 0.1.12, not here. */
export interface ExecutionLimits {
  /** CPU time the script may use, in milliseconds. */
  readonly cpuMs: number;
  /** Elapsed time before the run is stopped, in milliseconds. */
  readonly wallClockMs: number;
  /** Tool, search and describe calls the script may make in total. */
  readonly maxHostCalls: number;
  /** Largest final value returned to the core, in bytes of JSON. */
  readonly maxResultBytes: number;
}

/**
 * What the script can ask the core for. The broker implements this; the executor
 * exposes it to the script as `tools.<server>_<tool>(args)`, `search()` and `describe()`.
 *
 * A rejected promise is delivered to the script as a thrown error it can catch (FR-7).
 */
export interface SandboxHost {
  /** `path` is the sanitised function name, for example `github_list_issues`. */
  callTool(path: string, args: unknown): Promise<unknown>;
  search(query: string): Promise<unknown>;
  describe(path: string): Promise<unknown>;
  /**
   * Told when the run is over, however it ended. A host that has this sends nothing
   * upstream afterwards, even for a call that was already being checked.
   */
  close?(): void;
}

export interface ExecutionRequest {
  /** Identifies the run in the audit log. */
  readonly runId: string;
  /** JavaScript source with top-level await, already past the static check (FR-33). */
  readonly script: string;
  readonly limits: ExecutionLimits;
  readonly host: SandboxHost;
}

/** Why a run did not complete. Task 0.1.4 maps these onto the public error codes. */
export type ExecutionFailureKind =
  /** The script threw, or was not valid JavaScript. */
  | "script_error"
  /** A failed `assert()` ended the run (FR-40). */
  | "assertion_failed"
  /** CPU or wall-clock limit reached. */
  | "timeout"
  /** Host-call or result-size limit reached. */
  | "quota_exceeded"
  /** The sandbox itself failed. Never retried outside the sandbox. */
  | "sandbox_fault";

export interface ExecutionFailure {
  readonly kind: ExecutionFailureKind;
  readonly message: string;
  /** Line in the script, when the sandbox can tell (FR-7). */
  readonly line?: number;
  /** For the audit log only, never for the caller: what the platform said when the sandbox failed. */
  readonly detail?: string;
}

export type ExecutionOutcome =
  | {
      readonly status: "completed";
      /** The script's final value, JSON-serialisable. */
      readonly result: unknown;
      /** Captured `console.log` output, in order. */
      readonly logs: readonly string[];
      /** True when `result` was cut to fit `maxResultBytes` (FR-5). */
      readonly truncated: boolean;
      /** `assert()` calls that passed, when the sandbox counts them (FR-40). */
      readonly assertionsPassed?: number;
    }
  | {
      readonly status: "failed";
      readonly failure: ExecutionFailure;
      readonly logs: readonly string[];
      readonly assertionsPassed?: number;
    };

export interface Executor {
  /** Names the implementation in the audit log, for example `dynamic-worker`. */
  readonly name: string;
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}
