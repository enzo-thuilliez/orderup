import { execFile } from 'node:child_process';
import { formatDiff } from './diff.js';
import {
  BACKUP_SUFFIX,
  formatSettings,
  readSettings,
  withOurHooks,
  withoutOurHooks,
  writeSettings,
} from './settings.js';

/** First Claude Code release where background hook completions are silent (ADR-011). */
export const QUIET_ASYNC_HOOKS_VERSION = '2.1.119';

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

/** Background hooks only when we know Claude Code runs them silently. */
export function supportsQuietAsync(version: string | null): boolean {
  return version !== null && compareVersions(version, QUIET_ASYNC_HOOKS_VERSION) >= 0;
}

async function applyChange(
  file: string,
  change: (settings: Record<string, unknown>) => Record<string, unknown>,
  question: string,
  io: Io,
): Promise<'written' | 'unchanged' | 'cancelled'> {
  const current = await readSettings(file);
  const next = change(current.settings);
  const before = current.text ?? '';
  const after = formatSettings(next, current.text);
  if (next === current.settings || after === before) return 'unchanged';

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
  async: boolean;
  io: Io;
}): Promise<InstallResult> {
  const { file, port, async, io } = options;
  const result = await applyChange(
    file,
    (settings) => withOurHooks(settings, { port, async }),
    'Write these hooks to settings.json? [y/N] ',
    io,
  );
  if (result === 'unchanged') io.out(`OrderUp hooks are already installed in ${file}.\n`);
  if (result === 'cancelled') io.out('No changes made.\n');
  if (result === 'written') {
    io.out('Hooks installed. Claude Code picks them up automatically, no restart needed.\n');
  }
  return result === 'written' ? 'installed' : result;
}

export async function uninstallHooks(options: { file: string; io: Io }): Promise<UninstallResult> {
  const { file, io } = options;
  const result = await applyChange(
    file,
    withoutOurHooks,
    'Remove OrderUp hooks from settings.json? [y/N] ',
    io,
  );
  if (result === 'unchanged') io.out(`No OrderUp hooks in ${file}.\n`);
  if (result === 'cancelled') io.out('No changes made.\n');
  if (result === 'written') io.out('OrderUp hooks removed. Your other hooks are untouched.\n');
  return result === 'written' ? 'removed' : result === 'unchanged' ? 'none' : result;
}
