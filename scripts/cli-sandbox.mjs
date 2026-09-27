// Runs the OrderUp CLI from source with a throwaway HOME, so manual checks of the hook
// installer never touch the real ~/.claude. Usage: npm run cli:sandbox -- --install-hooks
// Reuse a sandbox across runs with ORDERUP_SANDBOX_HOME (it must be under the temp dir).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = realpathSync(os.tmpdir());
const reuse = process.env.ORDERUP_SANDBOX_HOME;
const home = reuse ? path.resolve(reuse) : mkdtempSync(path.join(tmp, 'orderup-sandbox-'));
// Checked before creating anything: never fall back to, or create under, a real HOME.
if (!home.startsWith(tmp + path.sep)) {
  console.error(`cli:sandbox: ${home} is not under ${tmp}; refusing to use it as HOME.`);
  process.exit(1);
}
mkdirSync(home, { recursive: true });
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.CLAUDE_CONFIG_DIR;
console.log(`sandbox HOME: ${home} (reuse with ORDERUP_SANDBOX_HOME=${home})`);

const tsx = path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = path.join(import.meta.dirname, '..', 'packages', 'cli', 'src', 'index.ts');
const { status } = spawnSync(
  process.execPath,
  [tsx, '--conditions=source', cli, ...process.argv.slice(2)],
  { env, stdio: 'inherit' },
);
process.exit(status ?? 1);
