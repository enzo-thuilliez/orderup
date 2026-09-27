/**
 * The command Claude Code runs for each hook event: a tiny inline Node script that pipes the
 * hook payload (stdin) to the local server and always exits 0 with no output.
 *
 * Why a command and not a native `http` hook (ADR-011): when OrderUp isn't running, an `http`
 * hook's connection failure is a non-blocking error that Claude Code shows as a
 * "hook error" notice on every event. A command that exits 0 silently is invisible.
 *
 * Node is referenced by absolute path: hooks may run without the user's shell PATH (nvm,
 * fnm and friends only set it up in interactive shells).
 */

/** Marks OrderUp's hook commands in settings.json. Never change: uninstall relies on it. */
export const HOOK_MARKER = '/*orderup-hook*/';

/** Whole-run cap for the forwarder, in milliseconds. */
export const FORWARDER_BUDGET_MS = 1500;

/** A command hook's `command`, plus `args` in exec form (no shell). */
export interface HookCommand {
  command: string;
  args?: string[];
}

export interface ForwarderOptions {
  port: number;
  /** Absolute path of the Node binary to run. */
  node: string;
  /** Exec form (`args`, Claude Code 2.1.139+): no shell, so no quoting to get wrong. */
  execForm: boolean;
}

/** The script has no quote characters (strings are template literals): safe in `'…'`. */
export function forwarderScript(port: number): string {
  return (
    HOOK_MARKER +
    'const h=require(`http`),c=[];' +
    'const q=()=>process.exit(0);' +
    `setTimeout(q,${FORWARDER_BUDGET_MS});` +
    'process.stdin.on(`error`,q).on(`data`,d=>c.push(d)).on(`end`,()=>{' +
    `const r=h.request({host:\`127.0.0.1\`,port:${port},path:\`/hook\`,method:\`POST\`,` +
    'headers:{[`content-type`]:`application/json`},timeout:1000},s=>{s.resume();s.on(`end`,q)});' +
    'r.on(`error`,q).on(`timeout`,q);r.end(Buffer.concat(c))})'
  );
}

/** POSIX shell quoting (sh, Git Bash). Plain paths stay readable in settings.json. */
export function shellQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function forwarderHook({ port, node, execForm }: ForwarderOptions): HookCommand {
  const script = forwarderScript(port);
  if (execForm) return { command: node, args: ['-e', script] };
  return { command: `${shellQuote(node)} -e '${script}'` };
}

/** The forwarder script inside a hook entry, or null if the entry isn't OrderUp's. */
function scriptOf(hook: { command?: unknown; args?: unknown }): string | null {
  const parts = [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])];
  const script = parts.find((part) => typeof part === 'string' && part.includes(HOOK_MARKER));
  return typeof script === 'string' ? script : null;
}

export function isForwarderHook(hook: { command?: unknown; args?: unknown }): boolean {
  return scriptOf(hook) !== null;
}

/** The port an installed forwarder posts to, or null if it can't be read. */
export function forwarderPort(hook: { command?: unknown; args?: unknown }): number | null {
  const match = /port:(\d+)/.exec(scriptOf(hook) ?? '');
  return match ? Number(match[1]) : null;
}

/** The Node an installed forwarder runs: a path, or a bare `node` looked up on PATH. */
export function forwarderNode(hook: { command?: unknown; args?: unknown }): string | null {
  if (typeof hook.command !== 'string' || !isForwarderHook(hook)) return null;
  if (Array.isArray(hook.args)) return hook.command;
  const quoted = /^'((?:[^']|'\\'')*)'\s/.exec(hook.command);
  if (quoted) return quoted[1]!.replace(/'\\''/g, "'");
  return /^(\S+)\s/.exec(hook.command)?.[1] ?? null;
}
