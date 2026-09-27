/**
 * The command Claude Code runs for each hook event: a tiny inline Node script that pipes the
 * hook payload (stdin) to the local server and always exits 0 with no output.
 *
 * Why a command and not a native `http` hook (ADR-011): when OrderUp isn't running, an `http`
 * hook's connection failure is a non-blocking error that Claude Code shows as a
 * "hook error" notice on every event. A command that exits 0 silently is invisible.
 *
 * The script contains no quote characters (strings are template literals), so the same
 * command string works under `sh`, Git Bash and PowerShell.
 */

/** Marks OrderUp's hook commands in settings.json. Never change: uninstall relies on it. */
export const HOOK_MARKER = '/*orderup-hook*/';

/** Whole-run cap for the forwarder, in milliseconds. */
export const FORWARDER_BUDGET_MS = 1500;

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

export function forwarderCommand(port: number): string {
  return `node -e '${forwarderScript(port)}'`;
}

export function isForwarderCommand(command: unknown): command is string {
  return typeof command === 'string' && command.includes(HOOK_MARKER);
}

/** The port an installed forwarder posts to, or null if it can't be read. */
export function forwarderPort(command: string): number | null {
  const match = /port:(\d+)/.exec(command);
  return match ? Number(match[1]) : null;
}
