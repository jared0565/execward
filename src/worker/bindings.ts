/**
 * What the core Worker is allowed to reach (FR-24, task 1.1.1).
 *
 * A binding is a resource the platform hands to the Worker: a database, a
 * secret, another service. The Worker can reach nothing it has no binding for,
 * so this list is the whole of its reach. It starts as small as it can be.
 */

/** Pinned runtime behaviour (FR-23). Must equal `compatibility_date` in wrangler.jsonc. */
export const COMPATIBILITY_DATE = "2026-11-13";

/** Compatibility flags the Worker may set. None are needed yet. */
export const ALLOWED_COMPATIBILITY_FLAGS: readonly string[] = [];

/**
 * Every binding the Worker may have: the config section it is declared in, and
 * the name it has in code. Adding a row here is a security decision.
 */
export const ALLOWED_BINDINGS = [
  /** Loads a model-written script into a Dynamic Worker (task 1.2). */
  { section: "worker_loaders", binding: "LOADER" },
] as const;

/**
 * Config keys that are not bindings and are allowed, with the value each must
 * have where that matters. Anything not here and not a section named in
 * `ALLOWED_BINDINGS` is refused, so a kind of binding this file has never
 * heard of is refused too.
 */
export const ALLOWED_SETTINGS = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "execward",
  main: "src/worker.ts",
  /** Off until sign-in exists: the Worker has no public address. */
  workers_dev: false,
  preview_urls: false,
  /** No usage data is sent to the tool's vendor from this repository. */
  send_metrics: false,
  upload_source_maps: true,
} as const;

/** The Worker's environment as the platform supplies it. Typed fully in task 1.2. */
export interface Env {
  readonly LOADER: unknown;
}
