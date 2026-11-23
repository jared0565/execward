/**
 * The Dynamic Worker executor (task 1.2.1): the first implementation of the
 * `Executor` interface in ../executor.ts.
 *
 * Each run loads the script into a new isolate that has:
 *   - no network (`globalOutbound: null`);
 *   - no bindings and no environment values (`env: {}`);
 *   - no Node.js compatibility layer, so no `process`, `Buffer` or `node:` modules;
 *   - no globals beyond the Sandbox API and the allowed language built-ins.
 *
 * The only thing it is handed is a `HostBridge`, passed as a capability: an
 * object in the host that forwards `tools.*`, `search()` and `describe()` to
 * the `SandboxHost`. The script never holds a credential or a binding.
 *
 * This file imports the Workers runtime, so it runs only inside a Worker.
 */
import { RpcTarget } from "cloudflare:workers";
import type { ExecutionOutcome, ExecutionRequest, Executor, SandboxHost } from "../executor";
import { COMPATIBILITY_DATE } from "../worker/bindings";
import { failed, fault, interpretReport } from "./outcome";
import { RUNNER_MODULE, buildSandboxModules } from "./sandbox-modules";

/** Turns the Node.js compatibility layer off inside the sandbox. */
export const SANDBOX_COMPATIBILITY_FLAGS = ["no_nodejs_compat", "no_nodejs_compat_v2"] as const;

/** The part of the Worker Loader binding the executor uses. */
export interface WorkerLoader {
  load(code: {
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
    readonly mainModule: string;
    readonly modules: Readonly<Record<string, string>>;
    readonly env: Readonly<Record<string, never>>;
    readonly globalOutbound: null;
    readonly limits: { readonly cpuMs: number };
  }): { getEntrypoint(name: string): { run(host: HostBridge): Promise<unknown> } };
}

/**
 * The script's only way out. It counts calls, refuses them once the run's
 * limit is reached, and refuses all of them once the run has ended, so a
 * script that outlives its time limit can do nothing more.
 */
export class HostBridge extends RpcTarget {
  #host: SandboxHost;
  #maxCalls: number;
  #calls = 0;
  #closed = false;
  quotaExceeded = false;

  constructor(host: SandboxHost, maxCalls: number) {
    super();
    this.#host = host;
    this.#maxCalls = maxCalls;
  }

  #admit(): void {
    if (this.#closed) throw new Error("the run has ended");
    this.#calls++;
    if (this.#calls > this.#maxCalls) {
      this.quotaExceeded = true;
      throw new Error(`the run's limit of ${this.#maxCalls} calls was reached`);
    }
  }

  async callTool(path: unknown, args: unknown): Promise<unknown> {
    this.#admit();
    if (typeof path !== "string") throw new Error("a tool name must be text");
    return this.#host.callTool(path, args);
  }

  async search(query: unknown): Promise<unknown> {
    this.#admit();
    if (typeof query !== "string") throw new Error("a search query must be text");
    return this.#host.search(query);
  }

  async describe(path: unknown): Promise<unknown> {
    this.#admit();
    if (typeof path !== "string") throw new Error("a tool name must be text");
    return this.#host.describe(path);
  }

  close(): void {
    this.#closed = true;
  }
}

const TIMED_OUT = Symbol("timed out");

export function dynamicWorkerExecutor(loader: WorkerLoader): Executor {
  return {
    name: "dynamic-worker",
    async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
      const built = buildSandboxModules(request.script);
      if (!built.ok) return failed("script_error", built.message, [], built.line);

      const bridge = new HostBridge(request.host, request.limits.maxHostCalls);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const worker = loader.load({
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: SANDBOX_COMPATIBILITY_FLAGS,
          mainModule: RUNNER_MODULE,
          modules: built.modules,
          env: {},
          globalOutbound: null,
          limits: { cpuMs: request.limits.cpuMs },
        });
        // The platform offers no wall-clock limit, so the host keeps the clock,
        // where the script cannot reach it.
        const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), request.limits.wallClockMs);
        });
        const report = await Promise.race([worker.getEntrypoint("Code").run(bridge), deadline]);

        if (report === TIMED_OUT) {
          return failed("timeout", `the run did not finish within ${request.limits.wallClockMs} ms`);
        }
        if (bridge.quotaExceeded) {
          // Whatever the script went on to do or return, the run is over the limit.
          return failed("quota_exceeded", `the run made more than ${request.limits.maxHostCalls} calls`);
        }
        return interpretReport(report, request.limits);
      } catch (error) {
        if (bridge.quotaExceeded) {
          return failed("quota_exceeded", `the run made more than ${request.limits.maxHostCalls} calls`);
        }
        // The platform ends an isolate that goes over its CPU or memory limit by failing the call,
        // with these messages (seen on a deployed Worker, 2026-11-23). Those are the limits working,
        // not a fault. A script cannot produce them: an error it throws is caught inside the sandbox
        // and comes back in the report.
        const platform = error instanceof Error ? error.message : "";
        if (/exceeded CPU time limit/i.test(platform)) {
          return failed("timeout", `the run used more than its ${request.limits.cpuMs} ms of CPU time`);
        }
        if (/exceeded memory limit/i.test(platform)) {
          return failed("quota_exceeded", "the run used more memory than the sandbox allows");
        }
        // Rule 3 of the executor interface: on any fault, report it. Never run the script another way.
        return fault(`the sandbox failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        bridge.close();
      }
    },
  };
}
