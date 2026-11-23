/**
 * Checks the Worker's configuration against the allowlist (FR-23, FR-24).
 *
 * Default deny: a key the allowlist does not name is a problem, whatever it
 * is. That covers every kind of binding, environment values (`vars`), named
 * environments (`env`, which can carry their own bindings), routes and
 * anything the platform adds later.
 */
import {
  ALLOWED_BINDINGS,
  ALLOWED_COMPATIBILITY_FLAGS,
  ALLOWED_SETTINGS,
  ALLOWED_TRIGGERS,
  COMPATIBILITY_DATE,
} from "./bindings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes `//` and block comments from JSONC, leaving strings untouched.
 * Trailing commas are not accepted: the result must be plain JSON.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (char === '"') {
      const start = index;
      index++;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      index++;
      out += text.slice(start, index);
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index++;
    }
  }
  return out;
}

export function parseWorkerConfig(text: string): unknown {
  return JSON.parse(stripJsonComments(text)) as unknown;
}

/** Problems with a parsed wrangler configuration, in plain words. Empty means it passed. */
export function workerConfigProblems(config: unknown, today: Date = new Date()): string[] {
  if (!isRecord(config)) return ["the configuration is not a JSON object"];
  const problems: string[] = [];

  const bindingSections = new Set<string>(ALLOWED_BINDINGS.map((entry) => entry.section));
  const structured = new Set(["compatibility_date", "compatibility_flags", "observability", "triggers"]);
  for (const key of Object.keys(config)) {
    if (key in ALLOWED_SETTINGS || bindingSections.has(key) || structured.has(key)) continue;
    problems.push(`"${key}" is not on the allowlist`);
  }

  for (const [key, expected] of Object.entries(ALLOWED_SETTINGS)) {
    if (config[key] !== expected) {
      problems.push(`"${key}" must be ${JSON.stringify(expected)}, found ${JSON.stringify(config[key])}`);
    }
  }

  const date = config.compatibility_date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    problems.push(`"compatibility_date" must be a pinned date, found ${JSON.stringify(date)}`);
  } else {
    if (date !== COMPATIBILITY_DATE) {
      problems.push(`"compatibility_date" is ${date} but the code pins ${COMPATIBILITY_DATE}`);
    }
    if (date > today.toISOString().slice(0, 10)) {
      problems.push(`"compatibility_date" ${date} is in the future`);
    }
  }

  const flags = config.compatibility_flags ?? [];
  if (!Array.isArray(flags)) {
    problems.push(`"compatibility_flags" must be a list`);
  } else {
    for (const flag of flags) {
      if (typeof flag !== "string" || !ALLOWED_COMPATIBILITY_FLAGS.includes(flag)) {
        problems.push(`compatibility flag ${JSON.stringify(flag)} is not on the allowlist`);
      }
    }
  }

  const observability = config.observability;
  if (!isRecord(observability) || observability.enabled !== true || Object.keys(observability).length !== 1) {
    problems.push(`"observability" must be exactly { "enabled": true }`);
  }

  if (JSON.stringify(config.triggers) !== JSON.stringify(ALLOWED_TRIGGERS)) {
    problems.push(`"triggers" must be exactly ${JSON.stringify(ALLOWED_TRIGGERS)}`);
  }

  for (const section of bindingSections) {
    const entries = ALLOWED_BINDINGS.filter((entry) => entry.section === section);
    const allowed = entries.map((entry) => entry.binding);
    const declared = config[section];
    if (!Array.isArray(declared)) {
      problems.push(`"${section}" must be a list`);
      continue;
    }
    const names: string[] = [];
    for (const item of declared) {
      if (!isRecord(item) || typeof item.binding !== "string") {
        problems.push(`"${section}" has an entry with no binding name`);
        continue;
      }
      names.push(item.binding);
      if (!allowed.includes(item.binding)) {
        problems.push(`binding "${item.binding}" in "${section}" is not on the allowlist`);
      }
      // The entry may carry only the settings the allowlist names, each with the value it names:
      // a binding of the right name pointed at another database is not the allowed binding.
      const settings = entries.find((entry) => entry.binding === item.binding)?.settings ?? {};
      const extra = Object.keys(item).filter((key) => key !== "binding" && !Object.hasOwn(settings, key));
      if (extra.length > 0) {
        problems.push(`binding "${item.binding}" in "${section}" has settings that are not on the allowlist: ${extra.join(", ")}`);
      }
      for (const [key, expected] of Object.entries(settings)) {
        if (item[key] !== expected) problems.push(`binding "${item.binding}" in "${section}" must have "${key}" set to ${JSON.stringify(expected)}`);
      }
    }
    for (const binding of allowed) {
      const count = names.filter((name) => name === binding).length;
      if (count !== 1) problems.push(`binding "${binding}" must be declared once in "${section}", found ${count}`);
    }
  }
  return problems;
}
