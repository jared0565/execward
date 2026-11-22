/**
 * Checks made before any model call, so that a missing credential stops a run
 * at the start with one clear message, not as hundreds of failed runs.
 * Only the names of variables are ever read into messages, never their values.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export function missingKeys(env: Env, names: readonly string[]): string[] {
  return names.filter((name) => (env[name] ?? "").trim() === "");
}

export function assertKeysPresent(env: Env, names: readonly string[]): void {
  const missing = missingKeys(env, names);
  if (missing.length > 0) {
    throw new Error(
      `Cannot start: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        "No model call was made.",
    );
  }
}
