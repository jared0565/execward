/**
 * The pre-execution check on a model-written script (FR-33, task 1.2.3).
 *
 * It runs before the sandbox and refuses a script that is too large, does not
 * parse, holds a secret-shaped literal, uses a blocked construct, or references
 * a global outside the Sandbox API and the allowed language built-ins. It also
 * computes the script's hash for the audit log.
 *
 * This is a second layer, not the boundary. It reads the script's text; it
 * cannot follow a value computed at run time, so `tools["con" + "structor"]`
 * passes here. The sandbox is what stops that (task 1.2.1). What this check
 * buys is that the plain forms never reach the sandbox at all, and that a
 * script's intent to reach outside is caught and logged as a security event.
 */
import { parse } from "acorn";
import { analyze } from "eslint-scope";
import type { ExecWardError } from "../contracts/errors";
import { LANGUAGE_BUILTINS, SANDBOX_GLOBALS } from "../contracts/sandbox-api";
import { SCRIPT_LIMITS } from "../limits";

export type StaticCheckRule =
  | "size"
  | "parse"
  | "secret"
  | "blocked_construct"
  | "undeclared_global"
  | "global_assignment";

export interface StaticCheckProblem {
  readonly rule: StaticCheckRule;
  /** Plain words. Never contains the script's own text beyond an identifier name. */
  readonly message: string;
  /** Line in the script, counted from 1, when known. */
  readonly line?: number;
}

export type StaticCheckResult =
  | { readonly ok: true; readonly scriptHash: string }
  | {
      readonly ok: false;
      readonly scriptHash: string;
      readonly error: ExecWardError;
      readonly problems: readonly StaticCheckProblem[];
    };

/** The JavaScript edition scripts are parsed as. Newer syntax is refused, not guessed at. */
const ECMA_VERSION = 2024;

const ALLOWED_GLOBALS: ReadonlySet<string> = new Set<string>([...SANDBOX_GLOBALS, ...LANGUAGE_BUILTINS]);

/** Globals whose refusal is named after the blocked construct it stands for. */
const BLOCKED_GLOBALS: Readonly<Record<string, string>> = {
  eval: "eval",
  Function: "the Function constructor",
  WebAssembly: "WebAssembly compilation",
};

/**
 * Shapes of well-known credentials. A script has no reason to hold one, and a
 * script is stored in the audit log. Matching is by shape only.
 */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "a GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { name: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "an Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "an OpenAI-style API key", pattern: /\bsk-(?!ant-)(?:proj-|or-v1-)?[A-Za-z0-9_-]{32,}/ },
  { name: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "a Stripe live key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { name: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "a signed web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "a private key", pattern: new RegExp("-----BEGIN [A-Z ]*PRIVATE " + "KEY-----") },
];

interface AstNode {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } };
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

/** The property name a key refers to, when it can be read from the text. */
function staticKeyName(key: unknown, computed: boolean): string | undefined {
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier" && !computed) return typeof key.name === "string" ? key.name : undefined;
  if (key.type === "Literal") return typeof key.value === "string" ? key.value : undefined;
  if (key.type === "TemplateLiteral" && Array.isArray(key.expressions) && key.expressions.length === 0) {
    const first = Array.isArray(key.quasis) ? (key.quasis[0] as { value?: { cooked?: unknown } } | undefined) : undefined;
    return typeof first?.value?.cooked === "string" ? first.value.cooked : undefined;
  }
  return undefined;
}

function line(node: AstNode): { line: number } | Record<string, never> {
  return node.loc ? { line: node.loc.start.line } : {};
}

function constructProblems(program: AstNode): StaticCheckProblem[] {
  const problems: StaticCheckProblem[] = [];
  walk(program, (node) => {
    switch (node.type) {
      case "ImportExpression":
        problems.push({ rule: "blocked_construct", message: "dynamic import is not allowed", ...line(node) });
        break;
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
        problems.push({ rule: "blocked_construct", message: "import and export statements are not allowed", ...line(node) });
        break;
      case "MetaProperty":
        problems.push({ rule: "blocked_construct", message: "import.meta and new.target are not allowed", ...line(node) });
        break;
      case "MemberExpression":
        if (staticKeyName(node.property, node.computed === true) === "constructor") {
          problems.push({
            rule: "blocked_construct",
            message: "reading .constructor is not allowed: it leads to the Function constructor",
            ...line(node),
          });
        }
        break;
      case "Property":
        if (staticKeyName(node.key, node.computed === true) === "constructor") {
          problems.push({
            rule: "blocked_construct",
            message: 'a property named "constructor" is not allowed: it leads to the Function constructor',
            ...line(node),
          });
        }
        break;
    }
  });
  return problems;
}

interface ScopeReference {
  readonly identifier: { readonly name: string; readonly loc?: { readonly start: { readonly line: number } } | null };
  isWrite(): boolean;
}

function globalProblems(program: AstNode): StaticCheckProblem[] {
  const manager = analyze(program as unknown as Parameters<typeof analyze>[0], {
    ecmaVersion: ECMA_VERSION,
    sourceType: "module",
  });
  const unresolved = (manager.globalScope?.through ?? []) as unknown as readonly ScopeReference[];
  const problems: StaticCheckProblem[] = [];
  for (const reference of unresolved) {
    const name = reference.identifier.name;
    const at = reference.identifier.loc ? { line: reference.identifier.loc.start.line } : {};
    const blocked = BLOCKED_GLOBALS[name];
    if (blocked !== undefined) {
      problems.push({ rule: "blocked_construct", message: `${blocked} is not allowed`, ...at });
    } else if (!ALLOWED_GLOBALS.has(name)) {
      problems.push({ rule: "undeclared_global", message: `"${name}" is not part of the Sandbox API`, ...at });
    } else if (reference.isWrite()) {
      problems.push({ rule: "global_assignment", message: `"${name}" cannot be reassigned`, ...at });
    }
  }
  return problems;
}

function secretProblems(script: string): StaticCheckProblem[] {
  const problems: StaticCheckProblem[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(script);
    if (!match) continue;
    const lineNumber = script.slice(0, match.index).split("\n").length;
    // The matched text is never put in the message: the message is logged and shown to the model.
    problems.push({ rule: "secret", message: `the script contains what looks like ${name}`, line: lineNumber });
  }
  return problems;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function refused(scriptHash: string, problems: readonly StaticCheckProblem[]): StaticCheckResult {
  const first = problems[0];
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
  return {
    ok: false,
    scriptHash,
    problems,
    error: {
      code: "static_check_failed",
      message: `${first?.message ?? "the script failed the pre-execution check"}${more}`,
      ...(first?.line === undefined ? {} : { line: first.line }),
    },
  };
}

/**
 * Checks a script before it runs. Scripts are parsed as the body they will run
 * as: strict-mode module code with top-level `await` and `return`.
 */
export async function checkScript(script: string): Promise<StaticCheckResult> {
  const bytes = new TextEncoder().encode(script);
  const scriptHash = await sha256Hex(bytes);

  if (bytes.length > SCRIPT_LIMITS.maxScriptBytes) {
    return refused(scriptHash, [
      { rule: "size", message: `the script is ${bytes.length} bytes; the limit is ${SCRIPT_LIMITS.maxScriptBytes}` },
    ]);
  }

  const secrets = secretProblems(script);

  let program: AstNode;
  try {
    program = parse(script, {
      ecmaVersion: ECMA_VERSION,
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowHashBang: false,
      locations: true,
      // The scope analysis orders declarations and uses by character position.
      ranges: true,
    }) as unknown as AstNode;
  } catch (error) {
    const at = (error as { loc?: { line?: unknown } }).loc?.line;
    const reason = error instanceof Error ? error.message.replace(/\s*\(\d+:\d+\)$/, "") : "unknown error";
    return refused(scriptHash, [
      ...secrets,
      { rule: "parse", message: `the script is not valid JavaScript: ${reason}`, ...(typeof at === "number" ? { line: at } : {}) },
    ]);
  }

  let found: StaticCheckProblem[];
  try {
    found = [...constructProblems(program), ...globalProblems(program)];
  } catch {
    // Fail closed: a script the analysis cannot handle is refused, not waved through.
    found = [{ rule: "parse", message: "the script could not be analysed" }];
  }
  const problems = [...secrets, ...found];
  return problems.length === 0 ? { ok: true, scriptHash } : refused(scriptHash, problems);
}
