import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  defaultDbPath,
  localDay,
  openDatabase,
  Repository,
  STATION_DEFINITIONS,
  stationsHash,
  type BrigadeConfig,
  type BrigadeConfigPatch,
} from 'orderup-server';
import { installAgents, uninstallAgents } from './agents.js';
import type { Io } from './hooks.js';

/** `orderup crew …`: the brigade's settings (#21, ADR-016). Never starts a run. */

export type CrewArgs =
  | { command: 'help' }
  | { command: 'status' }
  | {
      command: 'set';
      stationCap?: number;
      globalCap?: number;
      dailyCapUsd?: number;
      repo?: string;
      /** `null`: back to the claude CLI's default (`--model default`). */
      chefModel?: string | null;
    }
  | { command: 'install-agents' | 'uninstall-agents'; repo?: string };

export function crewHelpText(): string {
  return `Usage: orderup crew <command> [options]

Configure the brigade: the head chef and its fixed stations (hot, garde-manger, commis,
pastry, dish). Crew stays off unless orderup is started with --crew.

Commands:
  status                    show the config, the stations, the caps and today's budget
  set [options]             change the config; any of:
    --repo <path>           working repo of the head chef (a git repo)
    --model <name>          head chef model (alias or full name), or "default"
    --station-cap <n>       cooks per station, soft limit in the chef's prompt (default 4)
    --global-cap <n>        concurrent station cooks in total (default 8)
    --budget <usd>          daily usage cap in API-equivalent USD, 0 disables crew (default 5)
  install-agents [--repo <path>]
                            fallback only: write the station subagents to .claude/agents/
                            (shows the diff and asks first). By default stations are passed
                            to claude with --agents and nothing is written to your repo.
  uninstall-agents [--repo <path>]
                            remove those files (only .claude/agents/orderup-<station>.md)

install-agents and uninstall-agents act on --repo, else the configured repo, else the
current directory.
`;
}

function positiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 1) {
    throw new Error(`invalid ${flag}: ${value} (a positive integer)`);
  }
  return n;
}

function budget(value: string): number {
  const n = Number(value.trim().replace(/^\$/, ''));
  if (value.trim() === '' || !Number.isFinite(n) || n < 0) {
    throw new Error(`invalid --budget: ${value} (a number of USD, 0 or more)`);
  }
  return n;
}

const MODEL = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

function model(value: string): string | null {
  const name = value.trim();
  if (name === 'default') return null;
  if (!MODEL.test(name) || name.length > 200) {
    throw new Error(`invalid --model: ${value} (a model alias or name, or "default")`);
  }
  return name;
}

export function parseCrewArgs(argv: string[]): CrewArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'station-cap': { type: 'string' },
      'global-cap': { type: 'string' },
      budget: { type: 'string' },
      repo: { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...extra] = positionals;
  if (values.help || command === undefined || command === 'help') return { command: 'help' };
  if (extra.length > 0) throw new Error(`unexpected argument: ${extra[0]}`);

  const setFlags = ['station-cap', 'global-cap', 'budget', 'model'] as const;
  const used = (names: readonly string[]) =>
    names.filter((name) => values[name as keyof typeof values] !== undefined);

  switch (command) {
    case 'status': {
      const stray = used([...setFlags, 'repo']);
      if (stray.length) throw new Error(`crew status takes no --${stray[0]}`);
      return { command };
    }
    case 'install-agents':
    case 'uninstall-agents': {
      const stray = used(setFlags);
      if (stray.length) throw new Error(`crew ${command} takes no --${stray[0]}`);
      if (values.repo?.trim() === '') throw new Error('invalid --repo: empty path');
      return values.repo === undefined ? { command } : { command, repo: values.repo };
    }
    case 'set': {
      if (used([...setFlags, 'repo']).length === 0) {
        throw new Error(
          'crew set needs at least one of --repo, --model, --station-cap, --global-cap, --budget',
        );
      }
      if (values.repo?.trim() === '') throw new Error('invalid --repo: empty path');
      const args: CrewArgs = { command };
      if (values['station-cap'] !== undefined)
        args.stationCap = positiveInt('--station-cap', values['station-cap']);
      if (values['global-cap'] !== undefined)
        args.globalCap = positiveInt('--global-cap', values['global-cap']);
      if (values.budget !== undefined) args.dailyCapUsd = budget(values.budget);
      if (values.model !== undefined) args.chefModel = model(values.model);
      if (values.repo !== undefined) args.repo = values.repo;
      return args;
    }
    default:
      throw new Error(`unknown crew command: ${command}. See: orderup crew --help`);
  }
}

export interface CrewDeps {
  io: Io;
  /** Opens the brigade database. Default: `~/.orderup/orderup.db`. */
  openRepository?: () => { repository: Repository; close(): void };
  /** Top level of the git work tree containing a directory, or null. */
  gitToplevel: (dir: string) => Promise<string | null>;
  cwd?: string;
  now?: () => number;
}

function defaultOpen(): { repository: Repository; close(): void } {
  const db = openDatabase(defaultDbPath());
  return { repository: new Repository(db), close: () => db.close() };
}

/** Resolves `dir` to the top of its git work tree, or throws a message the user can act on. */
async function resolveRepo(dir: string, deps: CrewDeps): Promise<string> {
  const abs = path.resolve(deps.cwd ?? process.cwd(), dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`${abs} is not a directory`);
  }
  const top = await deps.gitToplevel(abs);
  if (!top) throw new Error(`${abs} is not a git repository`);
  return path.resolve(top);
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function formatStatus(
  config: BrigadeConfig,
  spentToday: number,
  hash: string = stationsHash(),
): string {
  const rows: [string, string][] = [
    ['crew', 'off unless orderup is started with --crew'],
    ['repo', config.repoPath ?? 'not set. Set it with: orderup crew set --repo <path>'],
    ['chef model', config.chefModel ?? "default (the claude CLI's)"],
    [
      'caps',
      `${config.stationCap} per station (soft, in the chef's prompt), ${config.globalCap} in total`,
    ],
    [
      'budget',
      config.dailyCapUsd === 0
        ? `0: crew runs are disabled (${usd(spentToday)} used today)`
        : `${usd(config.dailyCapUsd)} per day, API-equivalent; ${usd(spentToday)} used today`,
    ],
    [
      'stations',
      `definitions ${hash.slice(0, 12)}` +
        (config.stationsHash === null
          ? ''
          : config.stationsHash === hash
            ? ' (recorded)'
            : `, recorded ${config.stationsHash.slice(0, 12)} differs`),
    ],
  ];
  const width = Math.max(...STATION_DEFINITIONS.map((def) => def.id.length));
  const nameWidth = Math.max(...STATION_DEFINITIONS.map((def) => def.name.length));
  const stations = STATION_DEFINITIONS.map(
    (def) =>
      `    ${def.id.padEnd(width)}  ${def.name.padEnd(nameWidth)}  ` +
      `${def.isolation ? 'worktree ' : 'read-only'}  ${def.tools.join(', ')}`,
  );
  return (
    `OrderUp brigade\n\n${rows.map(([k, v]) => `  ${k.padEnd(10)}  ${v}`).join('\n')}\n\n` +
    `  Stations (subagents passed to the head chef with --agents):\n${stations.join('\n')}\n`
  );
}

/** Runs one `orderup crew` command. Returns the exit code. */
export async function runCrew(args: CrewArgs, deps: CrewDeps): Promise<number> {
  const { io } = deps;
  if (args.command === 'help') {
    io.out(crewHelpText());
    return 0;
  }

  const { repository, close } = (deps.openRepository ?? defaultOpen)();
  try {
    const now = deps.now ?? Date.now;
    switch (args.command) {
      case 'status': {
        const spent = repository.usageTotalForDay(localDay(now())).costUsd;
        io.out(formatStatus(repository.getBrigadeConfig(), spent));
        return 0;
      }
      case 'set': {
        const patch: BrigadeConfigPatch = { stationsHash: stationsHash() };
        if (args.repo !== undefined) patch.repoPath = await resolveRepo(args.repo, deps);
        if (args.chefModel !== undefined) patch.chefModel = args.chefModel;
        if (args.stationCap !== undefined) patch.stationCap = args.stationCap;
        if (args.globalCap !== undefined) patch.globalCap = args.globalCap;
        if (args.dailyCapUsd !== undefined) patch.dailyCapUsd = args.dailyCapUsd;
        const config = repository.updateBrigadeConfig(patch, now());
        if (config.stationCap > config.globalCap) {
          io.out(
            `Note: the station cap (${config.stationCap}) is above the global cap ` +
              `(${config.globalCap}), so the global cap is the one that applies.\n`,
          );
        }
        io.out(formatStatus(config, repository.usageTotalForDay(localDay(now())).costUsd));
        return 0;
      }
      case 'install-agents':
      case 'uninstall-agents': {
        const config = repository.getBrigadeConfig();
        const repo = await resolveRepo(args.repo ?? config.repoPath ?? '.', deps);
        if (args.command === 'uninstall-agents') {
          await uninstallAgents({ repo, io });
          return 0;
        }
        if ((await installAgents({ repo, io })) !== 'cancelled') {
          repository.updateBrigadeConfig({ stationsHash: stationsHash() }, now());
        }
        return 0;
      }
    }
  } finally {
    close();
  }
}
