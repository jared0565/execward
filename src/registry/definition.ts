/**
 * Tool definitions and their pins (task 1.5.4, FR-22).
 *
 * A wrapped tool describes itself: a name, a description and schemas. The
 * model reads the description, so a tool that changes its description after
 * approval can tell the model anything. Each approved definition is therefore
 * pinned by hash, and a definition that no longer matches its pin is blocked.
 */
import { toolPath } from "../contracts/sandbox-api";

export interface ToolDefinitionRecord {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly inputSchema: unknown;
  /** JSON Schema for the result, when the tool declares one. */
  readonly outputSchema?: unknown;
}

/** Longest description a tool may have. Longer ones are not approved, and are cut wherever shown. */
export const MAX_DESCRIPTION_CHARS = 1_000;

export class DefinitionChangedError extends Error {
  override readonly name = "DefinitionChangedError";
}

/** JSON with object keys in a fixed order, so the same definition always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The hash of everything the model or the broker reads from a definition. */
export function definitionHash(definition: ToolDefinitionRecord): Promise<string> {
  return sha256Hex(
    canonicalJson({
      server: definition.server,
      tool: definition.tool,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema ?? null,
    }),
  );
}

/** The hash of the parts that decide what a call may send and what comes back. */
export function schemaHash(definition: ToolDefinitionRecord): Promise<string> {
  return sha256Hex(canonicalJson({ server: definition.server, tool: definition.tool, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema ?? null }));
}

export function pathOfDefinition(definition: Pick<ToolDefinitionRecord, "server" | "tool">): string {
  return toolPath(definition.server, definition.tool);
}

/** Characters that are invisible, reorder text, or carry hidden text. */
function hiddenCharacter(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/** Wording that addresses the reader instead of describing the tool. */
const INSTRUCTION_SIGNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "tells the reader to ignore instructions", pattern: /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(previous|prior|above|earlier|all|other|system)\b/i },
  { name: "the same, written with separators", pattern: /ignore[-_ ]+all[-_ ]+previous/i },
  { name: "speaks as the system", pattern: /\b(system\s*(prompt|note|message)|developer\s*message)\b|^\s*(system|assistant|user)\s*:/im },
  { name: "gives the reader orders", pattern: /\b(you\s+(must|should|are\s+now|will\s+now|have\s+to)|always\s+(call|use|send|include)|never\s+(tell|mention|reveal)|do\s+not\s+(tell|mention|reveal|inform))\b/i },
  { name: "asks for data to be sent somewhere", pattern: /\b(send|forward|post|upload|exfiltrate|email|leak)\b[\s\S]{0,60}\b(to|at)\b/i },
  { name: "contains a link", pattern: /\b(https?|ftp|file|data|javascript):/i },
  { name: "contains markup", pattern: /<\/?[a-z!][^>]*>|!\[[^\]]*\]\(|\]\(/i },
  { name: "names credentials", pattern: /\b(password|passphrase|api[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|private[-_ ]?key|credentials?)\b/i },
];

/**
 * Why a description should not be shown to a model, or an empty list.
 * A plain check for obvious signs, run on text a third party wrote. Passing
 * it does not make a description safe; it only makes the crude attacks fail.
 */
export function descriptionProblems(description: string): string[] {
  const problems: string[] = [];
  if (description.length > MAX_DESCRIPTION_CHARS) problems.push(`is longer than ${MAX_DESCRIPTION_CHARS} characters`);
  for (const char of description) {
    const code = char.codePointAt(0) ?? 0;
    // A line break or tab is ordinary in a description.
    if (hiddenCharacter(code) && code !== 0x0a && code !== 0x0d && code !== 0x09) {
      problems.push("contains hidden or control characters");
      break;
    }
  }
  for (const sign of INSTRUCTION_SIGNS) if (sign.pattern.test(description)) problems.push(sign.name);
  return problems;
}
