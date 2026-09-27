// Installs the orderup-cli tarball the way a user would and checks it end to end:
// package contents, `npx orderup --help`, then start, serve the kitchen and stop.
// Usage: npm run smoke (packs the current build), or node scripts/smoke-pack.mjs <file.tgz>.
// Everything runs in a temp dir with a throwaway HOME; the real ~/.claude is never touched.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const win = process.platform === 'win32';
const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'orderup-smoke-'));
const home = path.join(tmp, 'home');
const app = path.join(tmp, 'app');
const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
delete env.CLAUDE_CONFIG_DIR;

function step(name) {
  console.log(`smoke: ${name}`);
}

function fail(message) {
  throw new Error(message);
}

/** Runs npm/npx (`.cmd` shims on Windows need a shell), failing on a non-zero exit. */
function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell: win });
  if (res.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(full, base)
      : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function checkContents(pkgDir) {
  const files = listFiles(pkgDir);
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'bin/orderup.js',
    'dist/index.js',
    'dist/THIRD-PARTY-NOTICES.txt',
    'dist/web/index.html',
  ]) {
    if (!files.includes(required)) fail(`tarball is missing ${required}`);
  }
  const unwanted = files.filter(
    (f) => /\.(map|ts|tsbuildinfo)$/.test(f) || /^(src|test)\//.test(f) || f.includes('.test.'),
  );
  if (unwanted.length) fail(`tarball ships files it shouldn't: ${unwanted.join(', ')}`);

  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.private) fail('package.json is still private');
  const internal = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('orderup-'));
  if (internal.length) fail(`depends on unpublished workspaces: ${internal.join(', ')}`);

  // No absolute build-machine paths in shipped code.
  const needle = realpathSync(root);
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    if (readFileSync(path.join(pkgDir, f), 'utf8').includes(needle)) {
      fail(`${f} contains the local path ${needle}`);
    }
  }
  return pkg;
}

async function startStop(bin, port) {
  const child = spawn(process.execPath, [bin, '--no-open', '--port', String(port)], {
    cwd: app,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start within 20 s:\n${output}`)), 20_000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes('OrderUp kitchen open at')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before starting:\n${output}`));
    });
  });

  try {
    await ready;
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${base}/health`)).json();
    if (health.ok !== true) fail(`/health answered ${JSON.stringify(health)}`);

    const page = await fetch(`${base}/`);
    const html = await page.text();
    if (page.status !== 200 || !/<html/i.test(html)) fail(`/ answered ${page.status}`);
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    if (!asset) fail('index.html references no script');
    const script = await fetch(`${base}${asset}`);
    if (script.status !== 200) fail(`${asset} answered ${script.status}`);
    await script.arrayBuffer();
  } finally {
    child.kill('SIGTERM');
  }

  const { code, signal } = await exited;
  // Windows has no signals: kill() terminates the process, so only POSIX can check the exit.
  if (!win && code !== 0) fail(`stopped with code ${code} (signal ${signal}):\n${output}`);
  const stillUp = await fetch(`http://127.0.0.1:${port}/health`).then(
    () => true,
    () => false,
  );
  if (stillUp) fail(`port ${port} still answers after stop`);
}

try {
  mkdirSync(home);
  mkdirSync(app);
  let tarball = process.argv[2] && path.resolve(process.argv[2]);
  if (!tarball) {
    step('npm pack');
    const [packed] = JSON.parse(
      run('npm', ['pack', '-w', 'orderup-cli', '--json', '--pack-destination', tmp], root),
    );
    tarball = path.join(tmp, packed.filename);
  }
  if (!existsSync(tarball)) fail(`no tarball at ${tarball}`);

  step(`install ${path.basename(tarball)} in a temp project`);
  run('npm', ['init', '-y'], app);
  run('npm', ['install', '--no-audit', '--no-fund', tarball], app);

  const pkgDir = path.join(app, 'node_modules', 'orderup-cli');
  step('check package contents');
  const pkg = checkContents(pkgDir);

  step('npx orderup --help / --version');
  const help = run('npx', ['--no-install', 'orderup', '--help'], app);
  if (!help.includes('Usage: orderup')) fail(`unexpected --help output:\n${help}`);
  const version = run('npx', ['--no-install', 'orderup', '--version'], app).trim();
  if (version !== pkg.version) fail(`--version printed ${version}, package is ${pkg.version}`);

  step('start, serve the kitchen, stop');
  await startStop(path.join(pkgDir, 'bin', 'orderup.js'), await freePort());
  if (existsSync(path.join(home, '.claude', 'settings.json'))) {
    fail('a non-interactive run wrote settings.json');
  }

  console.log(
    `smoke: ok (orderup-cli ${pkg.version}, node ${process.version}, ${process.platform})`,
  );
} catch (err) {
  console.error(`smoke: FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
