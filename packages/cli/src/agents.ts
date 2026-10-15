import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agentFileHash,
  agentFileName,
  renderAgentFile,
  STATION_DEFINITIONS,
  stationsHash,
  type StationDefinition,
} from 'orderup-server';
import { formatDiff } from './diff.js';
import type { Io } from './hooks.js';

/**
 * The opt-in fallback of ADR-016 point 1: station subagents as files in a repo's
 * `.claude/agents/`. The default runtime path is `--agents`, which writes nothing; these files
 * exist only after `orderup crew install-agents`. Like the hooks (ADR-006), every change shows
 * a diff and asks first, and only the `orderup-<id>.md` files named by the definitions are
 * ever read, written or removed.
 */

export type AgentsInstallResult = 'installed' | 'unchanged' | 'cancelled';
export type AgentsUninstallResult = 'removed' | 'none' | 'cancelled';

export function agentsDir(repo: string): string {
  return path.join(repo, '.claude', 'agents');
}

interface AgentFile {
  def: StationDefinition;
  file: string;
  /** Current content, or null when the file doesn't exist. */
  text: string | null;
}

/** Reads our files only. Refuses anything that isn't a regular file (a symlink, a directory). */
async function readAgentFiles(
  repo: string,
  definitions: readonly StationDefinition[],
): Promise<AgentFile[]> {
  const dir = agentsDir(repo);
  return Promise.all(
    definitions.map(async (def) => {
      const file = path.join(dir, agentFileName(def));
      try {
        const stat = await lstat(file);
        if (!stat.isFile()) {
          throw new Error(`${file} is not a regular file; it was left untouched`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { def, file, text: null };
        throw err;
      }
      return { def, file, text: await readFile(file, 'utf8') };
    }),
  );
}

export type AgentFileState = 'current' | 'stale' | 'missing';

export interface AgentFilesStatus {
  dir: string;
  files: { name: string; file: string; state: AgentFileState; hash: string | null }[];
  /** At least one of our files exists. */
  installed: boolean;
  /** Every file exists and matches the current definitions. */
  current: boolean;
}

/** Whether the fallback files exist in `repo`, and whether they match the definitions. */
export async function agentFilesStatus(
  repo: string,
  definitions: readonly StationDefinition[] = STATION_DEFINITIONS,
): Promise<AgentFilesStatus> {
  const hash = stationsHash(definitions);
  const files = (await readAgentFiles(repo, definitions)).map(({ def, file, text }) => ({
    name: def.name,
    file,
    state: (text === null
      ? 'missing'
      : text === renderAgentFile(def, hash)
        ? 'current'
        : 'stale') as AgentFileState,
    hash: text === null ? null : agentFileHash(text),
  }));
  return {
    dir: agentsDir(repo),
    files,
    installed: files.some((f) => f.state !== 'missing'),
    current: files.every((f) => f.state === 'current'),
  };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.orderup-tmp`;
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, file);
}

function showDiff(io: Io, file: string, before: string | null, after: string | null): void {
  const label = before === null ? ' (new file)' : after === null ? ' (delete)' : '';
  io.out(`\n${file}${label}\n`);
  io.out(formatDiff(before ?? '', after ?? '', { color: io.color }));
}

/** Writes or updates `.claude/agents/orderup-<id>.md` in `repo`, after a diff and a yes. */
export async function installAgents(options: {
  repo: string;
  io: Io;
  definitions?: readonly StationDefinition[];
}): Promise<AgentsInstallResult> {
  const { repo, io, definitions = STATION_DEFINITIONS } = options;
  const hash = stationsHash(definitions);
  const changes = (await readAgentFiles(repo, definitions))
    .map((current) => ({ ...current, after: renderAgentFile(current.def, hash) }))
    .filter(({ text, after }) => text !== after);
  if (changes.length === 0) {
    io.out(`OrderUp station files in ${agentsDir(repo)} are already up to date.\n`);
    return 'unchanged';
  }

  for (const { file, text, after } of changes) showDiff(io, file, text, after);
  const count = `${changes.length} station file${changes.length > 1 ? 's' : ''}`;
  if (io.confirm && !(await io.confirm(`\nWrite these ${count}? [y/N] `))) {
    io.out('No changes made.\n');
    return 'cancelled';
  }

  await mkdir(agentsDir(repo), { recursive: true });
  for (const { file, after } of changes) await writeAtomic(file, after);
  io.out(
    `Wrote ${count} to ${agentsDir(repo)}. Review and commit them like any other change; ` +
      'remove them with: orderup crew uninstall-agents\n',
  );
  return 'installed';
}

/** Removes our `orderup-<id>.md` files from `repo`, after a diff and a yes. Nothing else. */
export async function uninstallAgents(options: {
  repo: string;
  io: Io;
  definitions?: readonly StationDefinition[];
}): Promise<AgentsUninstallResult> {
  const { repo, io, definitions = STATION_DEFINITIONS } = options;
  const present = (await readAgentFiles(repo, definitions)).filter(({ text }) => text !== null);
  if (present.length === 0) {
    io.out(`No OrderUp station files in ${agentsDir(repo)}.\n`);
    return 'none';
  }

  for (const { file, text } of present) showDiff(io, file, text, null);
  const count = `${present.length} station file${present.length > 1 ? 's' : ''}`;
  if (io.confirm && !(await io.confirm(`\nRemove these ${count}? [y/N] `))) {
    io.out('No changes made.\n');
    return 'cancelled';
  }

  for (const { file } of present) await unlink(file);
  io.out(`Removed ${count} from ${agentsDir(repo)}. Your other subagents are untouched.\n`);
  return 'removed';
}
