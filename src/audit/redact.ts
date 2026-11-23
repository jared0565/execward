/**
 * Removes secrets from a value before it is written to the audit log
 * (task 1.4.3, FR-21). Two rules:
 *
 *   - a field whose name says it holds a secret has its value replaced;
 *   - any text with the shape of a known credential has that part replaced.
 *
 * It works on a copy. Nothing here is perfect: a secret with no recognisable
 * shape, under an innocent name, is written as it is.
 */
import { SECRET_PATTERNS } from "../static-check/check";

const SECRET_NAME = /^(authorization|proxy[-_]?authorization|password|passwd|pwd|secret|token|cookie|set[-_]?cookie|credentials?|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|session[-_]?id|x[-_]api[-_]key)$/i;

const MAX_DEPTH = 40;

export function redactText(text: string): string {
  let out = text;
  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), `[redacted: ${name}]`);
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[redacted: nested too deeply to check]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // The field's name is kept, redacted in case the name itself is a secret.
    out[redactText(key)] = SECRET_NAME.test(key) ? "[redacted]" : redact(child, depth + 1);
  }
  return out;
}
