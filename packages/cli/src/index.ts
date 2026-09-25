import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from 'orderup-shared';
import { startServer } from 'orderup-server';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `orderup ${version}: watch your Claude Code sessions cook

Usage: orderup [options]

  --port <n>     port for the local server (default ${DEFAULT_PORT})
  --no-open      don't open the browser
  -h, --help     show this help
  -v, --version  print the version
`;

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      port: { type: 'string' },
      open: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    console.log(version);
    return;
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${values.port}`);
  }

  const server = await startServer({ port });
  console.log(`OrderUp kitchen open at ${server.url}`);
  // Stub: browser opening (unless --no-open) and the hook install prompt arrive with feat(cli).

  const shutdown = () => void server.close().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`orderup: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
