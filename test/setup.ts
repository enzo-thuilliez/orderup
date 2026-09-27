import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { assertTempHome } from './home-guard.js';

// Before any test module runs: a throwaway HOME, and no CLAUDE_CONFIG_DIR from the shell.
const home = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'orderup-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => assertTempHome());
afterEach(() => assertTempHome());
afterAll(() => rmSync(home, { recursive: true, force: true }));
