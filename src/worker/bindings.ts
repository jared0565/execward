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

export interface AllowedBinding {
  readonly section: string;
  readonly binding: string;
  /** The other settings the entry must have, each with exactly this value. None when absent. */
  readonly settings?: Readonly<Record<string, string>>;
}

/**
 * Every binding the Worker may have: the config section it is declared in, the
 * name it has in code, and the one resource it may point at. Adding a row here
 * is a security decision.
 */
export const ALLOWED_BINDINGS: readonly AllowedBinding[] = [
  /** Loads a model-written script into a Dynamic Worker (task 1.2). */
  { section: "worker_loaders", binding: "LOADER" },
  /** The Worker's own database: policy, audit log, switches, queue, counters (added 2026-11-23). */
  {
    section: "d1_databases",
    binding: "DB",
    settings: { database_name: "execward", database_id: "33b54ace-0649-4949-abe5-dacd833dfe10", migrations_dir: "migrations" },
  },
  /** Where the daily backup of that database is written (task 1.4.5, added 2026-11-23). */
  { section: "r2_buckets", binding: "BACKUPS", settings: { bucket_name: "execward-backups" } },
];

/**
 * The one timer the Worker runs on: every five minutes (src/worker/scheduled.ts).
 * The configuration's "triggers" must be exactly this.
 */
export const ALLOWED_TRIGGERS = { crons: ["*/5 * * * *"] } as const;

/**
 * The one address the Worker answers at: the owner console, behind Cloudflare
 * Access (task 1.6.1). The configuration's "routes" must be exactly this. Another
 * address would be a way in that Access does not guard.
 */
export const ALLOWED_ROUTES = [{ pattern: "console.execward.com", custom_domain: true }] as const;

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
  /** Off: the Worker's only address is the one in `ALLOWED_ROUTES`. */
  workers_dev: false,
  preview_urls: false,
  /** No usage data is sent to the tool's vendor from this repository. */
  send_metrics: false,
  upload_source_maps: true,
} as const;

/**
 * Every secret the Worker may hold. Neither is a credential for anything: they say
 * who the owner is, so that the console can refuse everyone else (task 1.6.1).
 * A secret not named here fails the deployed check.
 */
export const ALLOWED_SECRETS: readonly string[] = [
  /** The audience tag of the Cloudflare Access application that guards the console. */
  "ACCESS_AUD",
  /** The owner's sign-in address. A secret so that it is in no file and no log. */
  "OWNER_EMAIL",
];

/** The Worker's environment as the platform supplies it. Typed fully in task 1.2. */
export interface Env {
  readonly LOADER: unknown;
  readonly DB: unknown;
  readonly BACKUPS: unknown;
  readonly ACCESS_AUD?: string;
  readonly OWNER_EMAIL?: string;
}
