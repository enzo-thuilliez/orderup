import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from 'orderup-shared';

export interface CliOptions {
  port: number;
  open: boolean;
  demo: boolean;
  installHooks: boolean;
  uninstallHooks: boolean;
  doctor: boolean;
  /** Enable crew for this run (ADR-015). Off by default. */
  crew: boolean;
  /** Undocumented: also accept the Vite dev server origin (npm run dev). */
  dev: boolean;
  help: boolean;
  version: boolean;
}

export function helpText(version: string): string {
  return `orderup ${version}: watch your Claude Code sessions cook

Usage: orderup [options]
       orderup crew <command> [options]

  --port <n>          port for the local server (default ${DEFAULT_PORT})
  --no-open           don't open the browser
  --demo              open the kitchen with a scripted demo instead of live sessions
  --install-hooks     add OrderUp hooks to ~/.claude/settings.json (shows the diff first)
  --uninstall-hooks   remove OrderUp hooks from ~/.claude/settings.json
  --doctor            check hooks, their Node, the server and event delivery, and crew readiness
  --crew              enable the crew (head chef and stations) for this run; off by default
  -h, --help          show this help
  -v, --version       print the version

Hooks post to the port given with --port, so pass the same --port when installing them.

Crew commands (see orderup crew --help):
  crew status         show the brigade config, stations, caps and budget
  crew set ...        set --repo, --model, --station-cap, --global-cap or --budget
  crew install-agents / crew uninstall-agents
                      fallback only: station subagent files in a repo's .claude/agents/
`;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      port: { type: 'string' },
      open: { type: 'boolean', default: true },
      demo: { type: 'boolean', default: false },
      'install-hooks': { type: 'boolean', default: false },
      'uninstall-hooks': { type: 'boolean', default: false },
      doctor: { type: 'boolean', default: false },
      crew: { type: 'boolean', default: false },
      dev: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (values.port?.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  const actions = ['install-hooks', 'uninstall-hooks', 'doctor'] as const;
  const chosen = actions.filter((action) => values[action]);
  if (chosen.length > 1) {
    throw new Error(`${chosen.map((a) => `--${a}`).join(' and ')} cannot be used together`);
  }

  return {
    port,
    open: values.open,
    demo: values.demo,
    installHooks: values['install-hooks'],
    uninstallHooks: values['uninstall-hooks'],
    doctor: values.doctor,
    crew: values.crew,
    dev: values.dev,
    help: values.help,
    version: values.version,
  };
}
