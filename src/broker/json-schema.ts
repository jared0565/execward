/**
 * Checks a value against a tool's `inputSchema` (task 1.3.3, FR-34).
 *
 * A small interpreter for a fixed part of JSON Schema. It is written here,
 * rather than taken from a library, for two reasons: the usual validators
 * compile schemas into code, which the Workers runtime refuses; and this one
 * can be strict in ways the standard is not:
 *
 *   - An object accepts only the fields its schema lists, unless the schema
 *     explicitly says otherwise. The standard's default is the opposite.
 *   - A keyword this file does not implement makes the schema unusable. It is
 *     never skipped, because a skipped rule is a rule that does not hold.
 */

export type JsonSchema = { readonly [keyword: string]: unknown };

/** A string the schema marks as a URL or a file path, found while checking. */
export interface LocatedValue {
  readonly kind: "url" | "path";
  readonly value: string;
  /** Where in the arguments, for example `repo.path` or `urls[2]`. */
  readonly at: string;
}

export interface SchemaCheck {
  /** Plain words. Names fields and rules, never the offending value. */
  readonly problems: readonly string[];
  readonly located: readonly LocatedValue[];
}

const MAX_DEPTH = 32;
const MAX_PATTERN_INPUT = 10_000;
const MAX_PROBLEMS = 10;

/** Keywords that describe a schema without constraining a value. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "$comment"]);

const CHECKED = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "format",
  "anyOf",
]);

/** `uri` and `path` are enforced against the allowlists; the rest are shape checks. */
const FORMATS = new Set(["uri", "path", "date-time", "date"]);

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, wanted: string): boolean {
  const actual = typeOf(value);
  if (wanted === "number") return (actual === "number" || actual === "integer") && Number.isFinite(value as number);
  return actual === wanted;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Why a schema cannot be used, or an empty list. Run when a tool is registered
 * and again on every call, so a schema this file cannot fully enforce never
 * lets a call through.
 */
export function schemaProblems(schema: unknown, at = "schema", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [`${at}: nested too deeply`];
  if (!isRecord(schema)) return [`${at}: is not a schema object`];
  const problems: string[] = [];
  for (const keyword of Object.keys(schema)) {
    if (!CHECKED.has(keyword) && !ANNOTATIONS.has(keyword)) problems.push(`${at}: the keyword "${keyword}" is not supported`);
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const type of types) if (typeof type !== "string" || !TYPES.has(type)) problems.push(`${at}: unknown type`);
  if (schema.format !== undefined && (typeof schema.format !== "string" || !FORMATS.has(schema.format))) {
    problems.push(`${at}: the format "${String(schema.format)}" is not supported`);
  }
  if (schema.pattern !== undefined) {
    try {
      new RegExp(String(schema.pattern), "u");
    } catch {
      problems.push(`${at}: the pattern is not a valid expression`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) problems.push(`${at}: "properties" is not an object`);
    else for (const [name, child] of Object.entries(schema.properties)) problems.push(...schemaProblems(child, `${at}.${name}`, depth + 1));
  }
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((name) => typeof name === "string"))) {
    problems.push(`${at}: "required" is not a list of names`);
  }
  if (isRecord(schema.additionalProperties)) problems.push(...schemaProblems(schema.additionalProperties, `${at}.*`, depth + 1));
  else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    problems.push(`${at}: "additionalProperties" is neither true, false nor a schema`);
  }
  if (schema.items !== undefined) problems.push(...schemaProblems(schema.items, `${at}[]`, depth + 1));
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) problems.push(`${at}: "anyOf" is not a list of schemas`);
    else schema.anyOf.forEach((child, index) => problems.push(...schemaProblems(child, `${at}.anyOf[${index}]`, depth + 1)));
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) problems.push(`${at}: "enum" is not a list`);
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== "number") problems.push(`${at}: "${keyword}" is not a number`);
  }
  return problems;
}

interface Collected {
  problems: string[];
  located: LocatedValue[];
  /** Arguments are strict about unlisted fields; results follow the standard. */
  readonly unlistedFields: "refuse" | "allow";
}

function check(value: unknown, schema: JsonSchema, at: string, depth: number, out: Collected): void {
  if (out.problems.length >= MAX_PROBLEMS) return;
  if (depth > MAX_DEPTH) {
    out.problems.push(`${at}: nested too deeply`);
    return;
  }

  if (Array.isArray(schema.anyOf)) {
    // The value must satisfy at least one branch. URLs and paths are collected from every
    // branch it satisfies, not only the first: if any branch says a value is a URL, it is
    // checked as one, whatever order the branches are listed in.
    const passing = (schema.anyOf as JsonSchema[])
      .map((branch) => {
        const attempt: Collected = { problems: [], located: [], unlistedFields: out.unlistedFields };
        check(value, branch, at, depth + 1, attempt);
        return attempt;
      })
      .filter((attempt) => attempt.problems.length === 0);
    if (passing.length === 0) out.problems.push(`${at}: matches none of the allowed shapes`);
    else for (const attempt of passing) out.located.push(...attempt.located);
  }

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((type) => matchesType(value, type))) {
      out.problems.push(`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && !same(value, schema.const)) out.problems.push(`${at}: is not the one allowed value`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(value, option))) out.problems.push(`${at}: is not one of the allowed values`);

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) out.problems.push(`${at}: is below the minimum of ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) out.problems.push(`${at}: is above the maximum of ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) out.problems.push(`${at}: must be above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) out.problems.push(`${at}: must be below ${schema.exclusiveMaximum}`);
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) out.problems.push(`${at}: is shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) out.problems.push(`${at}: is longer than ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string") {
      if (value.length > MAX_PATTERN_INPUT) out.problems.push(`${at}: is too long to be checked against its pattern`);
      else if (!new RegExp(schema.pattern, "u").test(value)) out.problems.push(`${at}: does not match the required pattern`);
    }
    if (schema.format === "uri") out.located.push({ kind: "url", value, at });
    if (schema.format === "path") out.located.push({ kind: "path", value, at });
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) out.problems.push(`${at}: is not a date`);
    if (schema.format === "date-time" && !/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
      out.problems.push(`${at}: is not a date and time`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) out.problems.push(`${at}: has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) out.problems.push(`${at}: has more than ${schema.maxItems} items`);
    if (isRecord(schema.items)) value.forEach((item, index) => check(item, schema.items as JsonSchema, `${at}[${index}]`, depth + 1, out));
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!Object.hasOwn(value, name)) out.problems.push(`${at}: the field "${name}" is missing`);
    }
    for (const [name, child] of Object.entries(value)) {
      const where = at === "" ? name : `${at}.${name}`;
      if (Object.hasOwn(properties, name)) check(child, properties[name] as JsonSchema, where, depth + 1, out);
      else if (isRecord(schema.additionalProperties)) check(child, schema.additionalProperties, where, depth + 1, out);
      // Strict by default: only an explicit `additionalProperties: true` lets an unlisted field through.
      else if (schema.additionalProperties === false || (schema.additionalProperties !== true && out.unlistedFields === "refuse")) out.problems.push(`${at === "" ? "arguments" : at}: the field "${name}" is not allowed`);
    }
  }
}

/**
 * Checks `value` against `schema`. A schema with problems of its own fails every value.
 *
 * `unlistedFields` is "refuse" for arguments, which ExecWard's own caller writes,
 * and "allow" for results, where an upstream adding a field is not an attack.
 */
export function checkAgainstSchema(value: unknown, schema: unknown, unlistedFields: "refuse" | "allow" = "refuse"): SchemaCheck {
  const unusable = schemaProblems(schema);
  if (unusable.length > 0) return { problems: [`the tool's schema cannot be enforced (${unusable[0]})`], located: [] };
  const out: Collected = { problems: [], located: [], unlistedFields };
  check(value, schema as JsonSchema, "", 0, out);
  return { problems: out.problems.map((problem) => (problem.startsWith(":") ? `arguments${problem}` : problem)), located: out.located };
}
