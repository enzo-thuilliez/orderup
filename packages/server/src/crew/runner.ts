import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ChefRunTrigger, CrewRunStatus } from 'orderup-shared';
import { localDay, type Repository, type UsageTokens } from '../persistence/index.js';
import { agentsJson } from './stations.js';
import { parseStreamLine, type StreamEvent } from './stream.js';
import {
  defaultOrderupDir,
  ensureChefWorktree,
  installPushGuard,
  isValidTaskId,
  PROTECTED_BRANCH_ENV,
  type ChefWorktree,
} from './worktree.js';

/**
 * The crew runner (#19, ADR-015, ADR-016 points 1, 4, 5, 9 and 10): runs the head chef as the
 * user's own `claude -p` with stream-json output, in a per-task git worktree, under the daily
 * usage cap. Stations are subagents inside that one process (`--agents`), so they share its
 * process group, its environment (the push guard) and its cost.
 *
 * It holds no WebSocket or card logic: callers (#20, #31) turn its events into crew messages.
 */

/** ADR-015: max turns per run. */
export const MAX_TURNS = 30;
/** ADR-015: max concurrent members, which ADR-016 point 4 counts as `claude -p` processes. */
export const MAX_CONCURRENT_RUNS = 3;
/** ADR-016 point 4: station subagents cannot spawn cooks of their own. */
export const MAX_SUBAGENT_SPAWN_DEPTH = 1;
/** SIGTERM first so Claude Code runs its own cleanup; SIGKILL after this grace period. */
const KILL_GRACE_MS = 3000;
/** After the chef exits, how long to wait for the rest of its stdout. */
const STDOUT_DRAIN_MS = 2000;

/** Model names and session ids go to the CLI as option values: never one that reads as a flag. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface StartRunOptions {
  trigger: ChefRunTrigger;
  /** Chosen by the server (ADR-016 point 5). `[A-Za-z0-9_-]+`. */
  taskId: string;
  /** Sent to the CLI on stdin, never through a shell or the argument list. Never stored. */
  prompt: string;
  /** The chef session to continue (`--resume`), for a `send-back` or a follow-up `talk`. */
  resumeSessionId?: string;
}

export type StartRunRefusal =
  /** Already `MAX_CONCURRENT_RUNS` chef processes, or this task already has a running chef. */
  | 'busy'
  /** Today's usage reached the daily cap. */
  | 'usage_cap_reached'
  /** No working repo configured (`orderup crew set --repo`). */
  | 'no_repo'
  /** A malformed task id, session id or model name. */
  | 'invalid'
  /** The worktree or push guard could not be set up. */
  | 'setup_failed';

export type StartRunResult =
  { ok: true; runId: string } | { ok: false; code: StartRunRefusal; message: string };

/** What a run reports. No event carries prompt text (ADR-016 point 7). */
export type RunnerEvent =
  | { type: 'run.started'; runId: string; trigger: ChefRunTrigger; taskId: string }
  | { type: 'run.session'; runId: string; sessionId: string }
  /** Assistant text of the chef's own conversation (not its stations'). */
  | { type: 'run.text'; runId: string; text: string }
  | {
      type: 'run.tool';
      runId: string;
      toolUseId: string;
      name: string;
      /** Set when the call came from inside a station subagent. */
      parentToolUseId: string | null;
      /** `Agent` calls: the subagent name (`orderup-hot`). */
      subagentType?: string;
      /** `Agent` calls: the short dispatch description. */
      description?: string;
    }
  | { type: 'run.subagent'; runId: string; agentId: string; agentType: string | null }
  | {
      type: 'run.ended';
      runId: string;
      status: CrewRunStatus;
      /** This run's usage, stations included as far as the CLI reports them. */
      usage: { tokens: UsageTokens; costUsd: number };
      /** The chef's final text (where the report block is), or null if no result came. */
      resultText: string | null;
      exitCode: number | null;
    }
  | {
      type: 'budget.exceeded';
      /** The run that was killed, or null when a start was refused. */
      runId: string | null;
      capUsd: number;
      spentUsd: number;
    };

export interface RunnerOptions {
  repository: Repository;
  /** The user's `claude` binary. Default `claude` on PATH. */
  claudeBin?: string;
  /** Base environment of the chef process. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `~/.orderup`: worktrees and the hooks dir live here. */
  orderupDir?: string;
  /** Overrides `brigade_config.repo_path`. */
  repoPath?: string;
  onEvent?: (event: RunnerEvent) => void;
  now?: () => number;
}

interface ActiveRun {
  id: string;
  taskId: string;
  child: ChildProcess | null;
  sessionId: string | null;
  /** Cost of the session recorded before this run (resumed runs report the whole total). */
  priorSessionCostUsd: number;
  costUsd: number;
  tokens: UsageTokens;
  lastResult: Extract<StreamEvent, { kind: 'result' }> | null;
  /** Why the runner ended it, if it did. */
  endReason: 'stopped' | 'usage_cap_reached' | null;
  /** Agent tool_use id → subagent name, to tie an `agentId` to its station. */
  agentCalls: Map<string, string | null>;
  done: Promise<void>;
  killTimer?: NodeJS.Timeout;
  /** Set once stop() was asked before the process existed. */
  cancelled: boolean;
}

const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The `claude` arguments for a chef run. The prompt is not among them: it goes on stdin. */
export function buildChefArgs(options: {
  model?: string | null;
  resumeSessionId?: string;
  /** Remaining daily budget, passed as `--max-budget-usd`; omitted when there is no cap. */
  maxBudgetUsd?: number | null;
}): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // The headless and CLI docs pair stream-json with --verbose in print mode.
    '--verbose',
    '--max-turns',
    String(MAX_TURNS),
    '--agents',
    agentsJson(),
    // ADR-016 point 10: station worktrees branch from the chef's task branch.
    '--settings',
    JSON.stringify({ worktree: { baseRef: 'head' } }),
  ];
  if (options.model) args.push('--model', options.model);
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.maxBudgetUsd != null && options.maxBudgetUsd > 0) {
    // Never rounds down to 0.00, which would end the run before it starts.
    args.push('--max-budget-usd', Math.max(0.01, options.maxBudgetUsd).toFixed(2));
  }
  return args;
}

/** The chef's environment: the caps of ADR-016 point 4 and the push guard of #19. */
export function buildChefEnv(options: {
  base: NodeJS.ProcessEnv;
  globalCap: number;
  hooksDir: string;
  defaultBranch: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.base };
  // Drop inherited config entries so ours is the only one and the count stays right.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  delete env.GIT_CONFIG_PARAMETERS;
  return {
    ...env,
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(options.globalCap),
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(MAX_SUBAGENT_SPAWN_DEPTH),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: options.hooksDir,
    [PROTECTED_BRANCH_ENV]: options.defaultBranch,
  };
}

export class CrewRunner {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly repository: Repository;
  private readonly now: () => number;
  private readonly orderupDir: string;
  private closed = false;
  private readonly onExit = () => this.killAllNow();

  constructor(private readonly options: RunnerOptions) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.orderupDir = options.orderupDir ?? defaultOrderupDir();
    // Last resort if the server dies without stopAll(): kill the process groups synchronously.
    process.on('exit', this.onExit);
  }

  /** Running chef processes (including runs still setting up their worktree). */
  get activeRunIds(): string[] {
    return [...this.runs.keys()];
  }

  async startRun(options: StartRunOptions): Promise<StartRunResult> {
    const refuse = (code: StartRunRefusal, message: string): StartRunResult => ({
      ok: false,
      code,
      message,
    });
    if (this.closed) return refuse('busy', 'the runner is shutting down');
    if (!isValidTaskId(options.taskId)) return refuse('invalid', 'invalid task id');
    if (options.resumeSessionId !== undefined && !SESSION_ID_RE.test(options.resumeSessionId)) {
      return refuse('invalid', 'invalid session id');
    }
    if (this.runs.size >= MAX_CONCURRENT_RUNS) {
      return refuse('busy', `already ${MAX_CONCURRENT_RUNS} chef runs`);
    }
    if ([...this.runs.values()].some((run) => run.taskId === options.taskId)) {
      return refuse('busy', 'this task already has a running chef');
    }

    const config = this.repository.getBrigadeConfig();
    const repoPath = this.options.repoPath ?? config.repoPath;
    if (!repoPath) return refuse('no_repo', 'no working repo: orderup crew set --repo <path>');
    if (config.chefModel !== null && !MODEL_RE.test(config.chefModel)) {
      return refuse('invalid', 'invalid chef model');
    }
    const spent = this.spentToday();
    if (config.dailyCapUsd > 0 && spent >= config.dailyCapUsd) {
      this.emit({
        type: 'budget.exceeded',
        runId: null,
        capUsd: config.dailyCapUsd,
        spentUsd: spent,
      });
      return refuse('usage_cap_reached', 'daily usage cap reached');
    }

    // Reserve the slot before any await, so concurrent starts cannot exceed the limit.
    const runId = randomUUID();
    let settle!: () => void;
    const run: ActiveRun = {
      id: runId,
      taskId: options.taskId,
      child: null,
      sessionId: null,
      priorSessionCostUsd: 0,
      costUsd: 0,
      tokens: { ...ZERO_TOKENS },
      lastResult: null,
      endReason: null,
      agentCalls: new Map(),
      done: new Promise<void>((resolve) => (settle = resolve)),
      cancelled: false,
    };
    this.runs.set(runId, run);

    let worktree: ChefWorktree;
    let hooks: string;
    try {
      worktree = await ensureChefWorktree({
        repoPath,
        taskId: options.taskId,
        orderupDir: this.orderupDir,
      });
      hooks = await installPushGuard(this.orderupDir);
    } catch (error) {
      this.runs.delete(runId);
      settle();
      return refuse('setup_failed', error instanceof Error ? error.message : String(error));
    }
    if (run.cancelled || this.closed) {
      this.runs.delete(runId);
      settle();
      return refuse('busy', 'stopped before it started');
    }

    this.repository.startRun({
      id: runId,
      trigger: options.trigger,
      taskId: options.taskId,
      chefSessionId: options.resumeSessionId ?? null,
    });
    if (options.resumeSessionId) {
      run.sessionId = options.resumeSessionId;
      run.priorSessionCostUsd = this.repository.usageTotalForSession(
        options.resumeSessionId,
      ).costUsd;
      this.repository.addOwnedSession({ kind: 'chef', id: options.resumeSessionId, runId });
    }

    const args = buildChefArgs({
      model: config.chefModel,
      resumeSessionId: options.resumeSessionId,
      maxBudgetUsd: config.dailyCapUsd > 0 ? config.dailyCapUsd - spent : null,
    });
    const env = buildChefEnv({
      base: this.options.env ?? process.env,
      globalCap: config.globalCap,
      hooksDir: hooks,
      defaultBranch: worktree.defaultBranch,
    });

    const child = spawn(this.options.claudeBin ?? 'claude', args, {
      cwd: worktree.path,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so a stop kills the chef and everything it started.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    run.child = child;
    this.emit({ type: 'run.started', runId, trigger: options.trigger, taskId: options.taskId });

    // stderr is drained and dropped: it is the CLI's, and may echo anything.
    child.stderr?.resume();
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.prompt);

    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => {
      for (const event of parseStreamLine(line)) this.onStreamEvent(run, event);
    });
    const stdoutClosed = new Promise<void>((resolve) => lines.once('close', resolve));

    let finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      // Read what is left of stdout, but never wait on a straggler holding the pipe open.
      const drained = new Promise<void>((resolve) => setTimeout(resolve, STDOUT_DRAIN_MS).unref());
      void Promise.race([stdoutClosed, drained]).then(() => {
        clearTimeout(run.killTimer);
        lines.close();
        child.stdout?.destroy();
        this.finishRun(run, exitCode);
        settle();
      });
    };
    // ENOENT and friends: no process, and stdout ends on its own.
    child.once('error', () => finish(null));
    child.once('exit', (code) => {
      // The chef is gone: anything left in its process group is an orphan.
      signalTree(child, 'SIGKILL');
      finish(code);
    });
    return { ok: true, runId };
  }

  /** Stops one run (`stop` command). Resolves once its process has exited. */
  async stop(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.endReason ??= 'stopped';
    run.cancelled = true;
    this.kill(run);
    await run.done;
    return true;
  }

  /** Stops every run and waits for their processes: called on server close. */
  async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id)));
    process.off('exit', this.onExit);
  }

  private emit(event: RunnerEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // A listener's failure never takes a run down.
    }
  }

  private spentToday(): number {
    return this.repository.usageTotalForDay(localDay(this.now())).costUsd;
  }

  private onStreamEvent(run: ActiveRun, event: StreamEvent): void {
    switch (event.kind) {
      case 'init':
        this.setSession(run, event.sessionId);
        return;
      case 'text':
        if (event.parentToolUseId === null) {
          this.emit({ type: 'run.text', runId: run.id, text: event.text });
        }
        return;
      case 'tool_use':
        if (event.subagentType !== undefined || event.name === 'Agent' || event.name === 'Task') {
          run.agentCalls.set(event.id, event.subagentType ?? null);
        }
        this.emit({
          type: 'run.tool',
          runId: run.id,
          toolUseId: event.id,
          name: event.name,
          parentToolUseId: event.parentToolUseId,
          ...(event.subagentType !== undefined ? { subagentType: event.subagentType } : {}),
          ...(event.description !== undefined ? { description: event.description } : {}),
        });
        return;
      case 'tool_result': {
        if (event.agentId === undefined || !run.agentCalls.has(event.toolUseId)) return;
        const agentType = run.agentCalls.get(event.toolUseId) ?? null;
        this.repository.addOwnedSession({
          kind: 'subagent',
          id: event.agentId,
          runId: run.id,
          agentType,
        });
        this.emit({ type: 'run.subagent', runId: run.id, agentId: event.agentId, agentType });
        return;
      }
      case 'result':
        this.onResult(run, event);
        return;
    }
  }

  private setSession(run: ActiveRun, sessionId: string): void {
    if (run.sessionId === sessionId && this.repository.getRun(run.id)?.chefSessionId) return;
    run.sessionId = sessionId;
    this.repository.setChefSession(run.id, sessionId);
    this.repository.addOwnedSession({ kind: 'chef', id: sessionId, runId: run.id });
    this.emit({ type: 'run.session', runId: run.id, sessionId });
  }

  /**
   * A `result` line: record this run's share of the cost, then enforce the daily cap. A
   * resumed session reports its whole total, so what the session already recorded (earlier
   * runs, earlier results of this run) is subtracted.
   */
  private onResult(run: ActiveRun, event: Extract<StreamEvent, { kind: 'result' }>): void {
    if (event.sessionId && event.sessionId !== run.sessionId) this.setSession(run, event.sessionId);
    run.lastResult = event;
    const recorded = run.sessionId
      ? this.repository.usageTotalForSession(run.sessionId).costUsd
      : run.costUsd;
    const delta = Math.max(0, event.totalCostUsd - Math.max(recorded, run.priorSessionCostUsd));
    const tokens = event.tokens;
    this.repository.addUsage({ runId: run.id, tokens, costUsd: delta, recordedAt: this.now() });
    run.costUsd += delta;
    run.tokens = {
      input: run.tokens.input + tokens.input,
      output: run.tokens.output + tokens.output,
      cacheRead: run.tokens.cacheRead + tokens.cacheRead,
      cacheWrite: run.tokens.cacheWrite + tokens.cacheWrite,
    };

    const cap = this.repository.getBrigadeConfig().dailyCapUsd;
    const spent = this.spentToday();
    if (cap > 0 && spent >= cap && run.endReason === null) {
      run.endReason = 'usage_cap_reached';
      this.emit({ type: 'budget.exceeded', runId: run.id, capUsd: cap, spentUsd: spent });
      this.kill(run);
    }
  }

  private finishRun(run: ActiveRun, exitCode: number | null): void {
    this.runs.delete(run.id);
    let status: CrewRunStatus;
    if (run.endReason) status = run.endReason;
    else if (exitCode === 0 && run.lastResult && !run.lastResult.isError) status = 'success';
    else status = 'error';
    // `runs.status` has no usage-cap value (migration 1): a cap kill is stored as stopped.
    this.repository.endRun(run.id, status === 'usage_cap_reached' ? 'stopped' : status);
    this.emit({
      type: 'run.ended',
      runId: run.id,
      status,
      usage: { tokens: run.tokens, costUsd: run.costUsd },
      resultText: run.lastResult?.text ?? null,
      exitCode,
    });
  }

  /** SIGTERM to the chef's process group, then SIGKILL after a grace period. */
  private kill(run: ActiveRun): void {
    const child = run.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    signalTree(child, 'SIGTERM');
    clearTimeout(run.killTimer);
    run.killTimer = setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS);
    run.killTimer.unref();
  }

  private killAllNow(): void {
    for (const run of this.runs.values()) {
      if (run.child) signalTree(run.child, 'SIGKILL');
    }
  }
}

/** Signals the child's whole process group (POSIX), or the child itself (Windows). */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}
