import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ChefRunTrigger, CrewRunStatus, TicketRef } from 'orderup-shared';
import { localDay, type Repository, type UsageTokens } from '../persistence/index.js';
import { buildChefSystemPrompt } from './chef-prompt.js';
import { agentsJson, STATION_ALLOW_RULES } from './stations.js';
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
  /** The task's ticket (`assign`), shown in the chef's report example. */
  ticket?: TicketRef | null;
}

export type StartRunRefusal =
  /** Already `MAX_CONCURRENT_RUNS` chef processes, or this task already has a running chef. */
  | 'busy'
  /** Less than `MIN_BUDGET_USD` of today's cap is left. */
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
  | {
      type: 'run.started';
      runId: string;
      trigger: ChefRunTrigger;
      taskId: string;
      /** The chef's worktree, its working directory. */
      cwd: string;
      /** Name of the working repo (its directory's basename). */
      repo: string;
    }
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
      /** File path or command, as hooks show it. */
      target: string | null;
    }
  /** A station's `agentId` became known (from its `Agent` result or `system/task_started`). */
  | {
      type: 'run.subagent';
      runId: string;
      agentId: string;
      agentType: string | null;
      /** The `Agent` call that started it, when known. */
      toolUseId: string | null;
    }
  /** A station finished: `completed`, or the CLI's error status. */
  | {
      type: 'run.subagent.ended';
      runId: string;
      toolUseId: string;
      agentId: string | null;
      status: string;
    }
  /** A tool call was denied without a prompt (a background station cannot ask). */
  | {
      type: 'run.permission-denied';
      runId: string;
      toolName: string | null;
      toolUseId: string | null;
      parentToolUseId: string | null;
      reason: string | null;
    }
  /**
   * A writing station's branch, for the merge (#31): from its `Agent` result, or from the
   * commit it made (`system/vcs_state_changed`). Its worktree is
   * `.claude/worktrees/agent-<agentId>` on `worktree-agent-<agentId>`.
   */
  | { type: 'run.branch'; runId: string; agentId: string | null; branch: string }
  /** This run's usage so far, after each `result` line. */
  | { type: 'run.usage'; runId: string; tokens: UsageTokens; costUsd: number }
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
  /** Usage of the session recorded before this run (resumed runs report the whole total). */
  priorSession: { costUsd: number; tokens: UsageTokens };
  costUsd: number;
  tokens: UsageTokens;
  lastResult: Extract<StreamEvent, { kind: 'result' }> | null;
  /** Why the runner ended it, if it did. */
  endReason: 'stopped' | 'usage_cap_reached' | null;
  /** Agent tool_use id → subagent name, to tie an `agentId` to its station. */
  agentCalls: Map<string, string | null>;
  /** `agentId`s already reported with `run.subagent`. */
  agents: Set<string>;
  /** Agent tool_use ids already reported with `run.subagent.ended`. */
  agentsEnded: Set<string>;
  /** Branches already reported with `run.branch`. */
  branches: Set<string>;
  /** The chef's worktree, once set up. */
  cwd: string | null;
  done: Promise<void>;
  killTimer?: NodeJS.Timeout;
  /** Set once stop() was asked before the process existed. */
  cancelled: boolean;
}

const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Smallest budget a run starts with. A minimal haiku turn costs about $0.0064 and the CLI
 * checks the budget between turns (probe case f), so with less left a run could do no real
 * work: the start is refused as `usage_cap_reached` instead.
 */
export const MIN_BUDGET_USD = 0.1;

/** The remaining budget in whole cents, rounded down so the CLI never gets more than is left. */
function budgetArg(remainingUsd: number): string {
  const cents = Math.floor(remainingUsd * 100 + 1e-9) / 100;
  return Math.max(MIN_BUDGET_USD, cents).toFixed(2);
}

/** The chef's `--settings` layer. The CLI merges it with the user's settings (probe case d). */
export function chefSettingsJson(): string {
  return JSON.stringify({
    worktree: { baseRef: 'head' },
    permissions: { allow: [...STATION_ALLOW_RULES] },
  });
}

/** The `claude` arguments for a chef run. The prompt is not among them: it goes on stdin. */
export function buildChefArgs(options: {
  model?: string | null;
  resumeSessionId?: string;
  /**
   * What is left of today's budget (`daily_cap_usd` minus today's usage), passed as
   * `--max-budget-usd` with a floor of `MIN_BUDGET_USD`. Null when the cap is 0 (no cap): the
   * flag is then omitted.
   */
  maxBudgetUsd?: number | null;
  /** The head chef's instructions (`buildChefSystemPrompt`), as `--append-system-prompt`. */
  appendSystemPrompt?: string;
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
    // ADR-016 point 10: station worktrees branch from the chef's task branch, and stations
    // may run git and the test and lint commands without a prompt they cannot answer.
    '--settings',
    chefSettingsJson(),
  ];
  if (options.model) args.push('--model', options.model);
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.maxBudgetUsd != null) {
    args.push('--max-budget-usd', budgetArg(options.maxBudgetUsd));
  }
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
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
    if (config.dailyCapUsd > 0 && config.dailyCapUsd - spent < MIN_BUDGET_USD) {
      this.emit({
        type: 'budget.exceeded',
        runId: null,
        capUsd: config.dailyCapUsd,
        spentUsd: spent,
      });
      return refuse(
        'usage_cap_reached',
        spent >= config.dailyCapUsd
          ? 'daily usage cap reached'
          : `less than $${MIN_BUDGET_USD.toFixed(2)} of the daily usage cap left`,
      );
    }

    // Reserve the slot before any await, so concurrent starts cannot exceed the limit.
    const runId = randomUUID();
    let settle!: () => void;
    const run: ActiveRun = {
      id: runId,
      taskId: options.taskId,
      child: null,
      sessionId: null,
      priorSession: { costUsd: 0, tokens: { ...ZERO_TOKENS } },
      costUsd: 0,
      tokens: { ...ZERO_TOKENS },
      lastResult: null,
      endReason: null,
      agentCalls: new Map(),
      agents: new Set(),
      agentsEnded: new Set(),
      branches: new Set(),
      cwd: null,
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
      run.priorSession = this.repository.usageTotalForSession(options.resumeSessionId);
      this.repository.addOwnedSession({ kind: 'chef', id: options.resumeSessionId, runId });
    }

    const args = buildChefArgs({
      model: config.chefModel,
      resumeSessionId: options.resumeSessionId,
      maxBudgetUsd: config.dailyCapUsd > 0 ? config.dailyCapUsd - spent : null,
      appendSystemPrompt: buildChefSystemPrompt({
        taskId: options.taskId,
        stationCap: config.stationCap,
        globalCap: config.globalCap,
        ticket: options.ticket ?? null,
      }),
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
    run.cwd = worktree.path;
    this.emit({
      type: 'run.started',
      runId,
      trigger: options.trigger,
      taskId: options.taskId,
      cwd: worktree.path,
      repo: path.basename(repoPath),
    });

    // stderr is drained and dropped: it is the CLI's, and may echo anything.
    child.stderr?.resume();
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.prompt);

    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => {
      for (const event of parseStreamLine(line, run.cwd)) this.onStreamEvent(run, event);
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
          target: event.target,
        });
        return;
      case 'tool_result': {
        if (event.agentId === undefined || !run.agentCalls.has(event.toolUseId)) return;
        this.addSubagent(run, event.agentId, event.toolUseId);
        if (event.worktreeBranch) this.addBranch(run, event.agentId, event.worktreeBranch);
        // A foreground station is done when its result comes; a background one
        // (`async_launched`) ends with `system/task_notification`.
        if (event.status === 'completed') {
          this.endSubagent(run, event.toolUseId, event.agentId, 'completed');
        }
        return;
      }
      case 'task_started':
        if (event.toolUseId !== null && !run.agentCalls.has(event.toolUseId)) {
          run.agentCalls.set(event.toolUseId, event.subagentType);
        }
        this.addSubagent(run, event.agentId, event.toolUseId);
        return;
      case 'task_ended':
        if (event.toolUseId !== null) {
          this.endSubagent(run, event.toolUseId, event.agentId, event.status);
        }
        return;
      case 'permission_denied':
        this.emit({
          type: 'run.permission-denied',
          runId: run.id,
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          parentToolUseId: event.parentToolUseId,
          reason: event.reason,
        });
        return;
      case 'vcs':
        if (event.change === 'commit' && event.branch) {
          this.addBranch(run, agentIdOfWorktree(event.cwd, event.branch), event.branch);
        }
        return;
      case 'result':
        this.onResult(run, event);
        return;
    }
  }

  /** Records a station's `agentId` once, whichever line reports it first. */
  private addSubagent(run: ActiveRun, agentId: string, toolUseId: string | null): void {
    if (run.agents.has(agentId)) return;
    run.agents.add(agentId);
    const agentType = toolUseId !== null ? (run.agentCalls.get(toolUseId) ?? null) : null;
    this.repository.addOwnedSession({ kind: 'subagent', id: agentId, runId: run.id, agentType });
    this.emit({ type: 'run.subagent', runId: run.id, agentId, agentType, toolUseId });
  }

  private endSubagent(
    run: ActiveRun,
    toolUseId: string,
    agentId: string | null,
    status: string,
  ): void {
    if (run.agentsEnded.has(toolUseId)) return;
    run.agentsEnded.add(toolUseId);
    this.emit({ type: 'run.subagent.ended', runId: run.id, toolUseId, agentId, status });
  }

  private addBranch(run: ActiveRun, agentId: string | null, branch: string): void {
    if (run.branches.has(branch)) return;
    run.branches.add(branch);
    this.emit({ type: 'run.branch', runId: run.id, agentId, branch });
  }

  private setSession(run: ActiveRun, sessionId: string): void {
    if (run.sessionId === sessionId && this.repository.getRun(run.id)?.chefSessionId) return;
    run.sessionId = sessionId;
    this.repository.setChefSession(run.id, sessionId);
    this.repository.addOwnedSession({ kind: 'chef', id: sessionId, runId: run.id });
    this.emit({ type: 'run.session', runId: run.id, sessionId });
  }

  /**
   * A `result` line, which is not the end of the run: a background station starts a second
   * turn in the same process (probe case a). Records this run's share of the usage, then
   * enforces the daily cap. `total_cost_usd` and `modelUsage` are cumulative for the process
   * and, for a resumed session, the conversation, so what the session already recorded
   * (earlier runs, earlier results of this run) is subtracted. Without `modelUsage`, this
   * turn's `usage` is added instead (chef only).
   */
  private onResult(run: ActiveRun, event: Extract<StreamEvent, { kind: 'result' }>): void {
    if (event.sessionId && event.sessionId !== run.sessionId) this.setSession(run, event.sessionId);
    run.lastResult = event;
    const recorded = run.sessionId
      ? this.repository.usageTotalForSession(run.sessionId)
      : { costUsd: run.costUsd, tokens: run.tokens };
    const already = (pick: (u: { costUsd: number; tokens: UsageTokens }) => number) =>
      Math.max(pick(recorded), pick(run.priorSession));
    const costUsd = Math.max(0, event.totalCostUsd - already((u) => u.costUsd));
    const total = event.processTokens;
    const tokens: UsageTokens = total
      ? {
          input: Math.max(0, total.input - already((u) => u.tokens.input)),
          output: Math.max(0, total.output - already((u) => u.tokens.output)),
          cacheRead: Math.max(0, total.cacheRead - already((u) => u.tokens.cacheRead)),
          cacheWrite: Math.max(0, total.cacheWrite - already((u) => u.tokens.cacheWrite)),
        }
      : event.tokens;
    this.repository.addUsage({ runId: run.id, tokens, costUsd, recordedAt: this.now() });
    run.costUsd += costUsd;
    run.tokens = {
      input: run.tokens.input + tokens.input,
      output: run.tokens.output + tokens.output,
      cacheRead: run.tokens.cacheRead + tokens.cacheRead,
      cacheWrite: run.tokens.cacheWrite + tokens.cacheWrite,
    };
    this.emit({ type: 'run.usage', runId: run.id, tokens: run.tokens, costUsd: run.costUsd });

    // `--max-budget-usd` is what was left of the daily cap: the CLI ending on it is the cap.
    const budgetExhausted =
      event.subtype === 'error_max_budget_usd' || event.terminalReason === 'budget_exhausted';
    const cap = this.repository.getBrigadeConfig().dailyCapUsd;
    const spent = this.spentToday();
    if (run.endReason === null && (budgetExhausted || (cap > 0 && spent >= cap))) {
      run.endReason = 'usage_cap_reached';
      this.emit({ type: 'budget.exceeded', runId: run.id, capUsd: cap, spentUsd: spent });
      // The CLI exits by itself on its budget (exit code 1); a crossing it missed is killed.
      if (!budgetExhausted) this.kill(run);
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

/**
 * The `agentId` of a station worktree (`.claude/worktrees/agent-<agentId>`, on
 * `worktree-agent-<agentId>`), from a `vcs_state_changed` line's `cwd` or `branch`.
 */
export function agentIdOfWorktree(cwd: string | null, branch: string | null): string | null {
  const fromCwd = cwd ? /[\\/]\.claude[\\/]worktrees[\\/]agent-([A-Za-z0-9_-]+)/.exec(cwd) : null;
  return (
    fromCwd?.[1] ?? (branch ? /^worktree-agent-([A-Za-z0-9_-]+)$/.exec(branch)?.[1] : null) ?? null
  );
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
