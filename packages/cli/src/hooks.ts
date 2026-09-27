import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { formatDiff } from './diff.js';
import { addOurHooksText, removeOurHooksText } from './edit.js';
import { versionManagerWarning } from './node-path.js';
import {
  BACKUP_SUFFIX,
  hasOurHooks,
  ourHooks,
  readSettings,
  SettingsError,
  withOurHooks,
  withoutOurHooks,
  writeSettings,
  type HookOptions,
} from './settings.js';

/** First Claude Code release where background hook completions are silent (ADR-011). */
export const QUIET_ASYNC_HOOKS_VERSION = '2.1.119';

/** First Claude Code release with exec-form command hooks (`args`, no shell). */
export const EXEC_FORM_HOOKS_VERSION = '2.1.139';

export interface Io {
  out(text: string): void;
  /**
   * Asks a yes/no question. Absent when there's no terminal to ask in: an explicit
   * `--install-hooks` / `--uninstall-hooks` is then the confirmation.
   */
  confirm?(question: string): Promise<boolean>;
  color?: boolean;
}

export type InstallResult = 'installed' | 'unchanged' | 'cancelled';
export type UninstallResult = 'removed' | 'none' | 'cancelled';

/** Installed Claude Code version, or null if `claude` isn't on the PATH. */
export function detectClaudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['--version'],
      { timeout: 3000, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout) => resolve(err ? null : (/\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null)),
    );
  });
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function atLeast(version: string | null, minimum: string): boolean {
  return version !== null && compareVersions(version, minimum) >= 0;
}

/**
 * What to install for this machine. Features the Claude Code version can't be confirmed to
 * support are left out: an unknown version gets synchronous, shell-form hooks.
 */
export function hookOptions(port: number, claude: string | null, node: string): HookOptions {
  return {
    port,
    node,
    async: atLeast(claude, QUIET_ASYNC_HOOKS_VERSION),
    execForm: atLeast(claude, EXEC_FORM_HOOKS_VERSION),
  };
}

type Json = Record<string, unknown>;

interface Change {
  /** Nothing to do: the file already is as it should be. */
  done(settings: Json): boolean;
  /** The resulting settings, which also validates the file's shape (SettingsError). */
  model(settings: Json): Json;
  /** The same change made on the text, keeping everything else byte for byte. */
  text(text: string): string;
}

async function applyChange(
  file: string,
  change: Change,
  question: string,
  io: Io,
): Promise<'written' | 'unchanged' | 'cancelled'> {
  const current = await readSettings(file);
  if (change.done(current.settings)) return 'unchanged';
  const expected = change.model(current.settings);
  const before = current.text ?? '';
  const after =
    before.trim() === '' ? `${JSON.stringify(expected, null, 2)}\n` : change.text(before);
  // Safety net: never write a text edit that disagrees with the model.
  if (!isDeepStrictEqual(JSON.parse(after), expected)) {
    throw new SettingsError(`couldn't edit ${file} safely; it was left untouched`);
  }
  if (after === before) return 'unchanged';

  io.out(`\n${file}${current.text === null ? ' (new file)' : ''}\n`);
  io.out(formatDiff(before, after, { color: io.color }));
  if (io.confirm && !(await io.confirm(question))) return 'cancelled';

  await writeSettings(current, after);
  if (current.text !== null) io.out(`Backup of the previous file: ${file}${BACKUP_SUFFIX}\n`);
  return 'written';
}

export async function installHooks(options: {
  file: string;
  port: number;
  /** Installed Claude Code version, from detectClaudeVersion(). */
  claude: string | null;
  /** Node binary for the hooks. Default: the one running OrderUp. */
  node?: string;
  io: Io;
}): Promise<InstallResult> {
  const { file, port, claude, node = process.execPath, io } = options;
  const wanted = hookOptions(port, claude, node);
  const result = await applyChange(
    file,
    {
      done: (settings) => hasOurHooks(settings, wanted),
      model: (settings) => withOurHooks(settings, wanted),
      text: (text) => addOurHooksText(text, wanted),
    },
    'Write these hooks to settings.json? [y/N] ',
    io,
  );
  if (result === 'unchanged') io.out(`OrderUp hooks are already installed in ${file}.\n`);
  if (result === 'cancelled') io.out('No changes made.\n');
  if (result === 'written') {
    io.out('Hooks installed. Claude Code picks them up automatically, no restart needed.\n');
    const warning = versionManagerWarning(node);
    if (warning) io.out(warning);
  }
  return result === 'written' ? 'installed' : result;
}

export async function uninstallHooks(options: { file: string; io: Io }): Promise<UninstallResult> {
  const { file, io } = options;
  const result = await applyChange(
    file,
    {
      done: (settings) => ourHooks(settings).length === 0,
      model: withoutOurHooks,
      text: removeOurHooksText,
    },
    'Remove OrderUp hooks from settings.json? [y/N] ',
    io,
  );
  if (result === 'unchanged') io.out(`No OrderUp hooks in ${file}.\n`);
  if (result === 'cancelled') io.out('No changes made.\n');
  if (result === 'written') io.out('OrderUp hooks removed. Your other hooks are untouched.\n');
  return result === 'written' ? 'removed' : result === 'unchanged' ? 'none' : result;
}
