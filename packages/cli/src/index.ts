import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from 'orderup-shared';
import { startServer, type RunningServer } from 'orderup-server';
import { helpText, parseCliArgs, type CliOptions } from './args.js';
import { openBrowser } from './browser.js';
import { fetchHealth, formatReport, nodeCheck, runDoctor } from './doctor.js';
import { detectClaudeVersion, installHooks, uninstallHooks, type Io } from './hooks.js';
import { hookStatus, readSettings, settingsPath } from './settings.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const VITE_DEV_ORIGIN = 'http://localhost:5173';

/**
 * The built kitchen: bundled next to the CLI in the published package (`dist/web/`), or the
 * workspace build in the monorepo (`packages/web/dist`). Works from both `src/` (tsx) and `dist/`.
 */
function resolveWebRoot(): string | undefined {
  return ['./web', '../../web/dist']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((dir) => existsSync(path.join(dir, 'index.html')));
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  rl.once('SIGINT', () => {
    abort.abort();
    // Ctrl+C at a prompt quits, as it would anywhere else.
    process.kill(process.pid, 'SIGINT');
  });
  try {
    const answer = await rl.question(question, { signal: abort.signal });
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

async function open(url: string, options: CliOptions): Promise<void> {
  if (!options.open) return;
  if (!(await openBrowser(url))) console.log(`Couldn't open a browser. Open ${url} yourself.`);
}

/** Offers to install hooks when they're missing (ADR-006); flags hooks for another port. */
async function checkHooks(options: CliOptions, io: Io, file: string): Promise<void> {
  let status;
  try {
    status = hookStatus((await readSettings(file)).settings);
  } catch (err) {
    io.out(`Couldn't read ${file}: ${(err as Error).message}\n`);
    return;
  }
  const install = `orderup --install-hooks${options.port === DEFAULT_PORT ? '' : ` --port ${options.port}`}`;

  if (status.installed) {
    const broken = status.nodes.map(nodeCheck).find((check) => check.level === 'FAIL');
    if (broken) {
      io.out(`OrderUp hooks are broken: ${broken.detail.replace(/ Fix: .*$/, '')}\n`);
      io.out(`Fix them with: ${install}\n`);
    } else if (!status.complete || !status.ports.includes(options.port)) {
      io.out(`OrderUp hooks in ${file} don't match this run. Update them with: ${install}\n`);
    }
    return;
  }

  io.out(
    "\nClaude Code hooks aren't installed, so OrderUp only reads transcripts: states lag " +
      'and the bell never rings.\n',
  );
  if (!io.confirm) {
    io.out(`Install them with: ${install}\n`);
    return;
  }
  if (!(await io.confirm(`Install OrderUp hooks? You'll see the change first. [y/N] `))) {
    io.out(`Skipped. Install them any time with: ${install}\n`);
    return;
  }
  await installHooks({ file, port: options.port, claude: await detectClaudeVersion(), io });
}

/** Starts the server, or returns null when OrderUp already runs on that port. */
async function start(
  options: CliOptions,
  webRoot: string | undefined,
): Promise<RunningServer | null> {
  try {
    return await startServer({
      port: options.port,
      webRoot,
      allowedOrigins: options.dev ? [VITE_DEV_ORIGIN] : [],
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await fetchHealth(options.port)) return null;
    // ADR-002: never fall back to another port, installed hooks wouldn't find it.
    throw new Error(
      `port ${options.port} is already in use. Free it, or run with --port <n> ` +
        '(and install hooks with the same --port).',
      { cause: err },
    );
  }
}

async function main(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(helpText(version));
    return;
  }
  if (options.version) {
    console.log(version);
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const io: Io = {
    out: (text) => void process.stdout.write(text),
    confirm: interactive ? confirm : undefined,
    color: interactive && !process.env.NO_COLOR,
  };
  const file = settingsPath();

  if (options.installHooks) {
    await installHooks({ file, port: options.port, claude: await detectClaudeVersion(), io });
    return;
  }
  if (options.uninstallHooks) {
    await uninstallHooks({ file, io });
    return;
  }
  if (options.doctor) {
    const report = await runDoctor({
      file,
      port: options.port,
      claude: await detectClaudeVersion(),
    });
    io.out(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const webRoot = resolveWebRoot();
  if (!webRoot && !options.dev) {
    console.warn("The kitchen web app isn't built: run `npm run build` first.");
  }
  const server = await start(options, webRoot);
  const base = server?.url ?? `http://127.0.0.1:${options.port}`;
  const url = `${base}/${options.demo ? '?demo' : ''}`;

  if (!server) {
    console.log(`OrderUp is already running at ${base}`);
    await open(url, options);
    return;
  }

  console.log(`OrderUp kitchen open at ${url}`);
  const shutdown = () => void server.close().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await open(url, options);
  // `npm run dev` (--dev) never offers to write the developer's real settings.json.
  if (!options.demo)
    await checkHooks(options, options.dev ? { ...io, confirm: undefined } : io, file);
  console.log('Press Ctrl+C to close the kitchen.');
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`orderup: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
