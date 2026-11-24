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
  readonly settings?: Readonly<Record<string, string | readonly string[]>>;
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
  /**
   * Sends the link-only emails (task 1.6.7, added 2026-11-24). It may send from one address only.
   * Who it sends to is the owner's address, a secret, fixed in code (src/console/mailer.ts).
   */
  { section: "send_email", binding: "EMAIL", settings: { allowed_sender_addresses: ["alerts@notify.execward.com"] } },
];

/** The key that holds a binding's name in its config entry, where it is not "binding". */
export const BINDING_NAME_KEY: Readonly<Record<string, string>> = { send_email: "name" };

/**
 * The one timer the Worker runs on: every five minutes (src/worker/scheduled.ts).
 * The configuration's "triggers" must be exactly this.
 */
export const ALLOWED_TRIGGERS = { crons: ["*/5 * * * *"] } as const;

/**
 * The two addresses the Worker answers at, each behind its own Cloudflare Access
 * application: the owner console (task 1.6.1) and the MCP server for model
 * clients (task 2.1.2). The configuration's "routes" must be exactly this. Another
 * address would be a way in that Access does not guard.
 */
export const ALLOWED_ROUTES = [
  { pattern: "console.execward.com", custom_domain: true },
  { pattern: "mcp.execward.com", custom_domain: true },
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
  /** Off: the Worker's only address is the one in `ALLOWED_ROUTES`. */
  workers_dev: false,
  preview_urls: false,
  /** No usage data is sent to the tool's vendor from this repository. */
  send_metrics: false,
  upload_source_maps: true,
} as const;

/**
 * Every secret the Worker may hold. The first three are credentials for nothing:
 * they say who the owner is and which Access application a request came through,
 * so that everyone else can be refused (tasks 1.6.1 and 2.1.2). The last three
 * are the GitHub App: its private key is the one real credential here, and it
 * can only read the repositories the owner installed the App on (task 1.1.2).
 * A secret not named here fails the deployed check.
 */
export const ALLOWED_SECRETS: readonly string[] = [
  /** The audience tag of the Cloudflare Access application that guards the console. */
  "ACCESS_AUD",
  /** The audience tag of the separate Access application that guards the MCP address. */
  "MCP_ACCESS_AUD",
  /** The owner's sign-in address. A secret so that it is in no file and no log. */
  "OWNER_EMAIL",
  /** The GitHub App's ID and the ID of its installation. Not secret in themselves; kept out of every file. */
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  /** The GitHub App's private key. It mints read-only tokens that last about an hour. */
  "GITHUB_APP_PRIVATE_KEY",
];

/** The Worker's environment as the platform supplies it. Typed fully in task 1.2. */
export interface Env {
  readonly LOADER: unknown;
  readonly DB: unknown;
  readonly BACKUPS: unknown;
  readonly EMAIL?: unknown;
  readonly ACCESS_AUD?: string;
  readonly MCP_ACCESS_AUD?: string;
  readonly OWNER_EMAIL?: string;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_INSTALLATION_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
}
