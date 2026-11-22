/**
 * Prints the eval task suite with each expected answer. Makes no model call.
 *
 *   npx tsx scripts/list-tasks.ts
 */
import { buildWorld } from "../src/eval/fixtures/world";
import { buildGithubTasks } from "../src/eval/tasks/github-tasks";

for (const task of buildGithubTasks(buildWorld())) {
  console.log(`${task.id} [${task.type}] => ${task.expected ?? "?"}\n  ${task.prompt}`);
}
