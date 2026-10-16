import { createHash } from 'node:crypto';
import type { WorkStation } from 'orderup-shared';

/**
 * Station definitions (ADR-016 points 1, 2 and 10), as data. The runner (#19) passes them to
 * the head chef with the claude CLI's `--agents` flag, so nothing is written into the user's
 * repo. `orderup crew install-agents` renders the same data as `.claude/agents/` files, the
 * opt-in fallback. Anything that changes here changes `stationsHash()`.
 */

/** Claude Code tool names a station may get (ADR-016 point 2). Never `Agent`. */
export type StationTool = 'Read' | 'Grep' | 'Glob' | 'Edit' | 'Write' | 'Bash';

export interface StationDefinition {
  id: WorkStation;
  /** Subagent name: the `--agents` key, or the file name and frontmatter `name`. */
  name: `orderup-${WorkStation}`;
  /** When the head chef should dispatch to this station. */
  description: string;
  tools: readonly StationTool[];
  /** Writing stations run in their own git worktree (ADR-016 point 10). */
  isolation?: 'worktree';
  /**
   * Writing stations accept file edits without asking: a background station cannot prompt,
   * so without it every edit is denied (ADR-016 Follow-ups, probe case c).
   */
  permissionMode?: 'acceptEdits';
  /** The station's system prompt. */
  prompt: string;
}

const READ_ONLY = ['Read', 'Grep', 'Glob'] as const satisfies readonly StationTool[];
const WRITING = [...READ_ONLY, 'Edit', 'Write', 'Bash'] as const satisfies readonly StationTool[];

/**
 * The Bash commands stations may run without a prompt, passed in the chef's `--settings` as
 * `permissions.allow`. Permission rules are per process, so they hold for the chef and every
 * station: git to record work, and the test and lint commands the pastry station runs.
 * Anything else a station runs in Bash is denied, since a background station cannot prompt:
 * `git push` among them. `disallowedTools` cannot deny it more narrowly: a `Bash(...)` rule
 * there removes the whole Bash tool (probe case h).
 */
export const STATION_ALLOW_RULES: readonly string[] = [
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npm run lint:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npx vitest:*)',
  'Bash(npx tsc:*)',
  'Bash(npx eslint:*)',
];

const SHARED_RULES = `Rules for every OrderUp station:
- You work for the head chef. Do only the task you were given, then report back.
- Never push, never touch the main or default branch, never bypass permissions.
- Keep your final message short: what you did, what you could not do, anything the chef must know.`;

const WORKTREE_RULES = `You run in your own git worktree, branched from the chef's task branch.
- Commit your work on your worktree branch with a clear, conventional commit message.
- End your final message with one line \`Branch: <branch>\` naming that branch (\`git status\` shows it), so the chef can merge it.
- If you changed nothing, say so and do not commit.`;

function writingPrompt(role: string): string {
  return `${role}\n\n${WORKTREE_RULES}\n\n${SHARED_RULES}\n`;
}

/** Fixed order: the order of `STATIONS` in orderup-shared, without `head-chef`. */
export const STATION_DEFINITIONS: readonly StationDefinition[] = [
  {
    id: 'hot',
    name: 'orderup-hot',
    description:
      'OrderUp hot station: backend and API work (server code, protocol, CLI). Edits code in its own worktree.',
    tools: WRITING,
    isolation: 'worktree',
    permissionMode: 'acceptEdits',
    prompt: writingPrompt(
      'You are the hot station of an OrderUp kitchen: the backend cook. You change server code, ' +
        'protocols, APIs and command-line tools. Follow the conventions of the code around you, ' +
        'keep changes focused, and run the relevant tests before you commit.',
    ),
  },
  {
    id: 'garde-manger',
    name: 'orderup-garde-manger',
    description:
      'OrderUp garde-manger station: frontend and UI work (web, scene, styles). Edits code in its own worktree.',
    tools: WRITING,
    isolation: 'worktree',
    permissionMode: 'acceptEdits',
    prompt: writingPrompt(
      'You are the garde-manger station of an OrderUp kitchen: the frontend cook. You change web ' +
        'UI, rendering and styles. Follow the conventions of the code around you, keep changes ' +
        'focused, and run the relevant tests and type checks before you commit.',
    ),
  },
  {
    id: 'commis',
    name: 'orderup-commis',
    description:
      'OrderUp commis station: read-only research. Answers questions about the code, maps it, and prepares context for other stations.',
    tools: READ_ONLY,
    prompt:
      'You are the commis station of an OrderUp kitchen: the research cook. You read code to ' +
      'answer questions, map where things live and prepare context for the other stations. You ' +
      'cannot edit files or run commands. Cite file paths and line numbers in your answer.\n\n' +
      `${SHARED_RULES}\n`,
  },
  {
    id: 'pastry',
    name: 'orderup-pastry',
    description:
      'OrderUp pastry station: tests and QA. Writes and runs tests, lint and type checks, and reports failures. Edits tests and fixtures only, in its own worktree.',
    tools: WRITING,
    isolation: 'worktree',
    permissionMode: 'acceptEdits',
    prompt: writingPrompt(
      'You are the pastry station of an OrderUp kitchen: the tests cook. You write and run ' +
        'tests, lint and type checks, and report failures precisely. You edit tests and test ' +
        'fixtures only: never change the code under test. If a test fails because of that code, ' +
        'report the failure and its cause to the chef instead of fixing it.',
    ),
  },
  {
    id: 'dish',
    name: 'orderup-dish',
    description:
      'OrderUp dish station: refactors and cleanup (renames, dead code, formatting, small refactors) without behaviour change. Edits code in its own worktree.',
    tools: WRITING,
    isolation: 'worktree',
    permissionMode: 'acceptEdits',
    prompt: writingPrompt(
      'You are the dish station of an OrderUp kitchen: the cleanup cook. You rename, remove dead ' +
        'code, format and make small refactors that do not change behaviour. Run the tests ' +
        'before you commit to show behaviour is unchanged.',
    ),
  },
];

/** `orderup-hot` → `hot`; null for any other subagent name. */
export function stationOfAgent(name: string): WorkStation | null {
  return STATION_DEFINITIONS.find((def) => def.name === name)?.id ?? null;
}

/** One `--agents` entry (sub-agents docs: CLI-defined subagents). */
export interface AgentJson {
  description: string;
  prompt: string;
  tools: StationTool[];
  isolation?: 'worktree';
  permissionMode?: 'acceptEdits';
}

/** The object for the claude CLI's `--agents` flag, keyed by subagent name. */
export function agentsObject(
  definitions: readonly StationDefinition[] = STATION_DEFINITIONS,
): Record<string, AgentJson> {
  return Object.fromEntries(
    definitions.map((def) => [
      def.name,
      {
        description: def.description,
        prompt: def.prompt,
        tools: [...def.tools],
        ...(def.isolation ? { isolation: def.isolation } : {}),
        ...(def.permissionMode ? { permissionMode: def.permissionMode } : {}),
      },
    ]),
  );
}

/** The value of the claude CLI's `--agents` flag: inline JSON. */
export function agentsJson(
  definitions: readonly StationDefinition[] = STATION_DEFINITIONS,
): string {
  return JSON.stringify(agentsObject(definitions));
}

/**
 * SHA-256 (hex) of the definitions as passed to `--agents`. Stored in `brigade_config` and
 * written into fallback files, so stale definitions can be detected.
 */
export function stationsHash(
  definitions: readonly StationDefinition[] = STATION_DEFINITIONS,
): string {
  return createHash('sha256').update(agentsJson(definitions)).digest('hex');
}

/** Marker line in a fallback file's frontmatter (a YAML comment), with the definitions hash. */
export const AGENT_FILE_MARKER = '# Managed by OrderUp (orderup crew install-agents).';

/** `orderup-<id>.md`: the only file names the fallback ever writes or removes. */
export function agentFileName(def: Pick<StationDefinition, 'name'>): string {
  return `${def.name}.md`;
}

/** Reads the definitions hash from a fallback file, or null if it has none. */
export function agentFileHash(text: string): string | null {
  return /^# Definitions hash: ([0-9a-f]{64})$/m.exec(text)?.[1] ?? null;
}

/**
 * A `.claude/agents/orderup-<id>.md` file: YAML frontmatter, then the prompt. Strings are
 * written as JSON strings, which YAML reads as double-quoted scalars.
 */
export function renderAgentFile(def: StationDefinition, hash: string = stationsHash()): string {
  const lines = [
    '---',
    AGENT_FILE_MARKER,
    `# Definitions hash: ${hash}`,
    `name: ${def.name}`,
    `description: ${JSON.stringify(def.description)}`,
    `tools: ${def.tools.join(', ')}`,
    ...(def.isolation ? [`isolation: ${def.isolation}`] : []),
    ...(def.permissionMode ? [`permissionMode: ${def.permissionMode}`] : []),
    '---',
    '',
    def.prompt.trimEnd(),
    '',
  ];
  return lines.join('\n');
}
