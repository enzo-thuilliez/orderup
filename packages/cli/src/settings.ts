import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forwarderCommand, forwarderPort, isForwarderCommand } from './forwarder.js';

/** Hook events OrderUp listens to (docs/architecture.md#hook-events). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

/** Claude Code may exit right after SessionEnd, which would cancel a background hook. */
const SYNC_EVENTS = new Set<string>(['SessionEnd']);

/** Claude Code's own timeout for our hooks, in seconds. The forwarder gives up sooner. */
export const HOOK_TIMEOUT_S = 5;

export const BACKUP_SUFFIX = '.orderup-bak';

type Json = Record<string, unknown>;

export interface HookOptions {
  port: number;
  /** Run in the background (`async: true`) so Claude Code never waits on OrderUp. */
  async: boolean;
}

export interface HookStatus {
  /** At least one OrderUp hook is present. */
  installed: boolean;
  /** Every event in HOOK_EVENTS has an OrderUp hook. */
  complete: boolean;
  /** Ports the installed hooks post to. */
  ports: number[];
}

export class SettingsError extends Error {}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeConfigDir(env), 'settings.json');
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ourHook(event: string, { port, async }: HookOptions): Json {
  return {
    type: 'command',
    command: forwarderCommand(port),
    timeout: HOOK_TIMEOUT_S,
    ...(async && !SYNC_EVENTS.has(event) ? { async: true } : {}),
  };
}

function isOurs(hook: unknown): boolean {
  return isObject(hook) && hook.type === 'command' && isForwarderCommand(hook.command);
}

/** The `hooks` object of a settings file, validated just enough to edit it safely. */
function hooksOf(settings: Json): Record<string, unknown[]> | undefined {
  const hooks = settings.hooks;
  if (hooks === undefined) return undefined;
  if (!isObject(hooks)) throw new SettingsError('"hooks" in settings.json is not an object');
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new SettingsError(`"hooks.${event}" in settings.json is not an array`);
    }
  }
  return hooks as Record<string, unknown[]>;
}

export function hookStatus(settings: Json): HookStatus {
  const hooks = hooksOf(settings) ?? {};
  const ports = new Set<number>();
  const covered = new Set<string>();
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!isOurs(hook)) continue;
        covered.add(event);
        const port = forwarderPort((hook as Json).command as string);
        if (port !== null) ports.add(port);
      }
    }
  }
  return {
    installed: covered.size > 0,
    complete: HOOK_EVENTS.every((event) => covered.has(event)),
    ports: [...ports],
  };
}

/** Removes exactly OrderUp's hooks, and only the containers that removal left empty. */
export function withoutOurHooks(settings: Json): Json {
  const hooks = hooksOf(settings);
  if (!hooks) return settings;
  const nextHooks: Record<string, unknown[]> = {};
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    const nextGroups: unknown[] = [];
    let eventChanged = false;
    for (const group of groups) {
      if (isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOurs)) {
        eventChanged = true;
        const kept = group.hooks.filter((hook) => !isOurs(hook));
        if (kept.length > 0) nextGroups.push({ ...group, hooks: kept });
      } else {
        nextGroups.push(group);
      }
    }
    changed ||= eventChanged;
    if (!eventChanged || nextGroups.length > 0) nextHooks[event] = nextGroups;
  }
  if (!changed) return settings;
  const { hooks: _hooks, ...rest } = settings;
  return Object.keys(nextHooks).length > 0 ? { ...settings, hooks: nextHooks } : rest;
}

/**
 * Adds OrderUp's hooks next to the user's own, in a group of their own per event. Existing
 * OrderUp hooks are replaced, so installing twice (or with a new port) never duplicates them.
 */
export function withOurHooks(settings: Json, options: HookOptions): Json {
  const base = withoutOurHooks(settings);
  const hooks = { ...(hooksOf(base) ?? {}) };
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [ourHook(event, options)] }];
  }
  return { ...base, hooks };
}

export interface SettingsFile {
  path: string;
  /** Raw file contents, or null when the file doesn't exist yet. */
  text: string | null;
  settings: Json;
}

export async function readSettings(file: string): Promise<SettingsFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: file, text: null, settings: {} };
    }
    throw err;
  }
  let settings: unknown;
  try {
    settings = text.trim() === '' ? {} : JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`${file} is not valid JSON (${(err as Error).message})`);
  }
  if (!isObject(settings)) throw new SettingsError(`${file} does not contain a JSON object`);
  return { path: file, text, settings };
}

/** Serializes settings keeping the file's indentation (two spaces by default). */
export function formatSettings(settings: Json, original: string | null): string {
  const indent = original ? /^[ \t]+(?=")/m.exec(original)?.[0] : undefined;
  return `${JSON.stringify(settings, null, indent ?? 2)}\n`;
}

/**
 * Writes settings.json atomically, after copying the current file to settings.json.orderup-bak.
 * Follows a symlinked settings.json (dotfile managers) instead of replacing the link.
 */
export async function writeSettings(file: SettingsFile, text: string): Promise<void> {
  let target = file.path;
  let mode = 0o644;
  if (file.text !== null) {
    target = await realpath(file.path);
    mode = (await stat(target)).mode & 0o777;
    await copyFile(target, `${file.path}${BACKUP_SUFFIX}`);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
  }
  const tmp = `${target}.orderup-tmp-${process.pid}`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, target);
}
