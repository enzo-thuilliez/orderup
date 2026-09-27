import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tests must never touch the real ~/.claude (AGENTS.md). Every test file gets a temporary
 * HOME from test/setup.ts, and this guard fails any test that runs with HOME or
 * CLAUDE_CONFIG_DIR outside the system temp directory.
 */

function resolved(dir: string): string {
  try {
    return realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

function inside(dir: string, parent: string): boolean {
  return dir !== parent && dir.startsWith(parent + path.sep);
}

export function assertTempHome(
  env: NodeJS.ProcessEnv = process.env,
  tmp: string = resolved(os.tmpdir()),
  realHome: string = resolved(os.userInfo().homedir),
): void {
  const dirs: [string, string | undefined][] = [
    ['HOME', env.HOME],
    ['USERPROFILE', process.platform === 'win32' ? env.USERPROFILE : undefined],
    ['CLAUDE_CONFIG_DIR', env.CLAUDE_CONFIG_DIR],
  ];
  if (!env.HOME) throw new Error('test guard: HOME is not set');
  for (const [name, value] of dirs) {
    if (value === undefined || value === '') continue;
    const dir = resolved(value);
    const underRealHome = dir === realHome || (inside(dir, realHome) && !inside(tmp, realHome));
    if (!inside(dir, tmp) || underRealHome) {
      throw new Error(
        `test guard: ${name}=${value} is not a temporary directory (under ${tmp}). ` +
          'Tests must never read or write the real ~/.claude.',
      );
    }
  }
}
