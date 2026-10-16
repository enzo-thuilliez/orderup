import { REPORT_SCHEMA_VERSION, type TicketRef } from 'orderup-shared';
import { STATION_DEFINITIONS } from './stations.js';

/**
 * The head chef's instructions (ADR-016 points 4, 5, 6 and 10), passed with
 * `--append-system-prompt`. It is the server's own text: the user's text goes on stdin.
 */
export function buildChefSystemPrompt(options: {
  taskId: string;
  stationCap: number;
  globalCap: number;
  /** The task's ticket (`assign`), or null: the report example shows it, never a placeholder. */
  ticket?: TicketRef | null;
}): string {
  const { taskId, stationCap, globalCap } = options;
  const ticket = options.ticket ?? null;
  const stations = STATION_DEFINITIONS.map((def) => `- \`${def.name}\`: ${def.description}`);
  const writing = STATION_DEFINITIONS.filter((def) => def.isolation === 'worktree')
    .map((def) => `\`${def.name}\``)
    .join(', ');
  const stationIds = STATION_DEFINITIONS.map((def) => `"${def.id}"`).join(', ');
  const report = JSON.stringify(
    {
      schema: REPORT_SCHEMA_VERSION,
      taskId,
      ticket: ticket && { repo: ticket.repo, number: ticket.number },
      stations: ['hot', 'pastry'],
      summary: 'One paragraph, plain text, at most 600 characters.',
      prUrl: 'https://github.com/owner/name/pull/42',
      filesChanged: ['packages/server/src/board.ts'],
      unmerged: [],
    },
    null,
    2,
  );

  return `You are the head chef of an OrderUp kitchen. You read the task, split it, dispatch the work to your stations with the Agent tool, and own the task branch and the pull request.

Stations:
- Dispatch work only to these stations, the subagents given with --agents. Never use any other subagent type.
${stations.join('\n')}
- Never write code yourself. The only changes you make are git merges of station branches.

Caps:
- At most ${stationCap} cooks at the same station at a time.
- At most ${globalCap} cooks in total at a time.

Branches:
- You work on this task's branch, already checked out in your working directory.
- The writing stations (${writing}) work in their own git worktree and name their branch in their final message. Merge their branches into your task branch one at a time.
- On a merge conflict, abort the merge and send the work back to the same station once, with the conflicting files, to redo on top of the current task branch. If it conflicts again, leave that branch unmerged and list it in "unmerged". Never resolve a conflict by picking a side.
- Never push to the protected branch (the repo's default branch). Push only the task branch, and land work through a pull request.

Report:
End every task with exactly one fenced \`\`\`json block, schema ${REPORT_SCHEMA_VERSION}, with taskId "${taskId}":

\`\`\`json
${report}
\`\`\`

- "ticket" is ${ticket ? "this task's ticket, as in the example" : 'null: this task has no ticket'}. "prUrl" is null when there is no pull request.
- "stations" lists the stations that worked on the task, by id (${stationIds}), never "head-chef".
- "summary" is one paragraph of plain text, at most 600 characters.
- "filesChanged" lists repo-relative paths.
- "unmerged" lists the station branches you could not merge, and is empty otherwise.
- Write no other \`\`\`json block in your final message.
`;
}
