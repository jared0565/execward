/**
 * Turns tool definitions into the typed functions a script calls
 * (task 1.5.2, FR-2): `tools.my_server_list_items(args): Promise<Result>`.
 *
 * The output is text a model reads, built from text a third party wrote. So
 * only two things are taken from a definition: its schemas, turned into types
 * by the rules below, and its description, shown only if it passes the scan
 * and always cut to the length cap. Descriptions inside a schema are not shown.
 */
import { descriptionProblems, MAX_DESCRIPTION_CHARS, pathOfDefinition, type ToolDefinitionRecord } from "./definition";

const MAX_DEPTH = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  return value === null || ["string", "number", "boolean"].includes(typeof value) ? JSON.stringify(value) : "unknown";
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** A TypeScript type for a JSON Schema. Anything not understood is `unknown`, never a guess. */
export function typeOfSchema(schema: unknown, depth = 0): string {
  if (!isRecord(schema) || depth > MAX_DEPTH) return "unknown";
  if (schema.const !== undefined) return literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map(literal).join(" | ");
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return schema.anyOf.map((branch) => typeOfSchema(branch, depth + 1)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map((type) => typeOfSchema({ ...schema, type }, depth + 1)).join(" | ");
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = typeOfSchema(schema.items, depth + 1);
      return item.includes(" ") ? `Array<${item}>` : `${item}[]`;
    }
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
      const fields = Object.entries(properties).map(([name, child]) => `${propertyName(name)}${required.has(name) ? "" : "?"}: ${typeOfSchema(child, depth + 1)}`);
      if (isRecord(schema.additionalProperties)) fields.push(`[key: string]: ${typeOfSchema(schema.additionalProperties, depth + 1)}`);
      else if (schema.additionalProperties === true) fields.push("[key: string]: unknown");
      return fields.length === 0 ? "Record<string, never>" : `{ ${fields.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

/** The description as a model may see it: scanned, cut, and unable to end a comment. */
export function shownDescription(description: string): string {
  if (descriptionProblems(description.slice(0, MAX_DESCRIPTION_CHARS)).length > 0) return "(description withheld: it did not pass the safety scan)";
  return description.slice(0, MAX_DESCRIPTION_CHARS).replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();
}

/** The declaration of one tool. */
export function typingFor(definition: ToolDefinitionRecord): string {
  const args = typeOfSchema(definition.inputSchema);
  // A tool with no output schema gets the generic type (FR-2).
  const result = definition.outputSchema === undefined ? "unknown" : typeOfSchema(definition.outputSchema);
  return `  /** ${shownDescription(definition.description)} */\n  ${pathOfDefinition(definition)}(args: ${args}): Promise<${result}>;`;
}

/** The declarations of several tools, as one block a model can read. */
export function typingsFor(definitions: readonly ToolDefinitionRecord[]): string {
  const sorted = [...definitions].sort((a, b) => (pathOfDefinition(a) < pathOfDefinition(b) ? -1 : 1));
  return `declare const tools: {\n${sorted.map(typingFor).join("\n")}\n};`;
}
