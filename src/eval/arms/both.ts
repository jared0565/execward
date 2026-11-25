/**
 * The "both" arm of the eval (task 2.1.9). The model is offered the `code` tool
 * and, beside it, the wrapped tools for looking around, for calling directly.
 *
 * This is the guard the project owner chose on 2026-11-24 for Claude Haiku, which
 * gave up on an exploratory task when each step of looking cost a script
 * (docs/decisions/1.9.6-description-both-families.md). The `code` tool's
 * description gains one paragraph saying which door suits which work.
 *
 * In this arm a direct call goes straight to the invented GitHub of the eval. On
 * the live server a direct call goes through the same controls as a script.
 */
import { CODE_TOOL_NAME } from "../../code-tool/description";
import { BOTH_DOORS_GUIDANCE, LOOKING_AROUND_TOOLS } from "../../code-tool/direct";
import type { ToolBackend } from "../types";
import type { CodeBackend } from "./code";

export interface BothBackend extends ToolBackend {
  readonly outcomes: CodeBackend["outcomes"];
  /** How many calls went to each door, so a run shows which the model chose. */
  readonly doors: { code: number; direct: number };
}

/**
 * A wrapped tool's name as a script writes it. A direct tool is listed under the same
 * name: with two names for one tool, both models wrote the direct name inside a script,
 * where it is no tool at all (measured 2026-11-24).
 */
const SCRIPT_PREFIX = "github_";

export function bothBackend(code: CodeBackend, direct: ToolBackend, listed: readonly string[] = LOOKING_AROUND_TOOLS): BothBackend {
  const doors = { code: 0, direct: 0 };
  const offered = direct.definitions.filter((definition) => listed.includes(definition.name)).map((definition) => ({ ...definition, name: `${SCRIPT_PREFIX}${definition.name}` }));
  const codeDefinition = code.definitions.find((definition) => definition.name === CODE_TOOL_NAME);
  if (!codeDefinition) throw new Error("the code backend offers no code tool");
  if (direct.definitions.some((definition) => definition.name === CODE_TOOL_NAME)) throw new Error("a wrapped tool has the code tool's name");
  return {
    definitions: [{ ...codeDefinition, description: `${codeDefinition.description}\n\n${BOTH_DOORS_GUIDANCE}` }, ...offered],
    outcomes: code.outcomes,
    doors,
    async call(name, args) {
      if (name === CODE_TOOL_NAME) {
        doors.code += 1;
        return code.call(name, args);
      }
      // A tool that was not listed is not offered here, whatever the backend behind would answer.
      if (!offered.some((definition) => definition.name === name)) throw new Error(`"${name.slice(0, 80)}" is not offered directly. Use the code tool.`);
      doors.direct += 1;
      return direct.call(name.slice(SCRIPT_PREFIX.length), args);
    },
  };
}
