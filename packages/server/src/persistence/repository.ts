import type { SQLOutputValue } from 'node:sqlite';
import type { Database } from './db.js';

/** What started a chef run (ADR-016 point 6). `approve` and `stop` start no run. */
export type RunTrigger = 'talk' | 'assign' | 'send-back';
export type RunStatus = 'running' | 'success' | 'error' | 'stopped';

/** One `claude -p` invocation of the head chef. Times are epoch ms. */
export interface Run {
  id: string;
  chefSessionId: string | null;
  taskId: string | null;
  trigger: RunTrigger;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Usage reported for a run, in tokens and API-equivalent USD (ADR-015). */
export interface UsageRecord {
  runId: string;
  tokens: UsageTokens;
  costUsd: number;
  /** Local calendar day, `YYYY-MM-DD`, the budget cap counts against. */
  day: string;
  recordedAt: number;
}

export interface UsageTotal {
  tokens: UsageTokens;
  costUsd: number;
}

/** The brigade's settings (ADR-016 point 9, #21). One per database. */
export interface BrigadeConfig {
  /** The working repo the head chef runs in, or null when not set. */
  repoPath: string | null;
  /** Model for the head chef, or null for the CLI's default. */
  chefModel: string | null;
  /** Soft cap of cooks per station, stated in the chef's prompt (ADR-016 point 4). */
  stationCap: number;
  /** Cap of concurrent station subagents (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). */
  globalCap: number;
  /** Daily usage cap in API-equivalent USD (ADR-015). 0 disables the cap: no daily limit. */
  dailyCapUsd: number;
  /** `stationsHash()` of the station definitions last recorded as in use. */
  stationsHash: string | null;
  /** Epoch ms of the last change, or null if never changed. */
  updatedAt: number | null;
}

/** A session the crew runner owns (ADR-016 point 9): the chef's, or a station subagent's. */
export interface OwnedSession {
  kind: 'chef' | 'subagent';
  /** Chef: the session id. Subagent: its `agentId`. */
  id: string;
  runId: string | null;
  /** Subagent only: its name (`orderup-hot`, or a non-OrderUp type), when known. */
  agentType: string | null;
  recordedAt: number;
}

export type BrigadeConfigPatch = Partial<Omit<BrigadeConfig, 'updatedAt'>>;

export const BRIGADE_DEFAULTS: Readonly<BrigadeConfig> = {
  repoPath: null,
  chefModel: null,
  stationCap: 4,
  globalCap: 8,
  dailyCapUsd: 5,
  stationsHash: null,
  updatedAt: null,
};

const BRIGADE_COLUMNS = {
  repoPath: 'repo_path',
  chefModel: 'chef_model',
  stationCap: 'station_cap',
  globalCap: 'global_cap',
  dailyCapUsd: 'daily_cap_usd',
  stationsHash: 'stations_hash',
} as const satisfies Record<keyof BrigadeConfigPatch, string>;

function toBrigadeConfig(row: Row): BrigadeConfig {
  return {
    repoPath: str(row.repo_path),
    chefModel: str(row.chef_model),
    stationCap: num(row.station_cap),
    globalCap: num(row.global_cap),
    dailyCapUsd: num(row.daily_cap_usd),
    stationsHash: str(row.stations_hash),
    updatedAt: row.updated_at === null ? null : num(row.updated_at),
  };
}

/** `YYYY-MM-DD` in local time: the user's day, which is what a daily cap means to them. */
export function localDay(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type Row = Record<string, SQLOutputValue>;

const num = (value: SQLOutputValue | undefined): number => Number(value ?? 0);
const str = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

function toRun(row: Row): Run {
  return {
    id: String(row.id),
    chefSessionId: str(row.chef_session_id),
    taskId: str(row.task_id),
    trigger: row.trigger as RunTrigger,
    startedAt: num(row.started_at),
    endedAt: row.ended_at === null ? null : num(row.ended_at),
    status: row.status as RunStatus,
  };
}

function toOwned(row: Row): OwnedSession {
  return {
    kind: row.kind as OwnedSession['kind'],
    id: String(row.id),
    runId: str(row.run_id),
    agentType: str(row.agent_type),
    recordedAt: num(row.recorded_at),
  };
}

function toUsage(row: Row): UsageRecord {
  return {
    runId: String(row.run_id),
    tokens: {
      input: num(row.input_tokens),
      output: num(row.output_tokens),
      cacheRead: num(row.cache_read_tokens),
      cacheWrite: num(row.cache_write_tokens),
    },
    costUsd: num(row.cost_usd),
    day: String(row.day),
    recordedAt: num(row.recorded_at),
  };
}

/** Typed access to the crew tables. Holds no state besides the open database. */
export class Repository {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  startRun(run: {
    id: string;
    trigger: RunTrigger;
    chefSessionId?: string | null;
    taskId?: string | null;
    startedAt?: number;
  }): Run {
    const startedAt = run.startedAt ?? this.now();
    this.db
      .prepare(
        `INSERT INTO runs (id, chef_session_id, task_id, trigger, started_at, status)
         VALUES (?, ?, ?, ?, ?, 'running')`,
      )
      .run(run.id, run.chefSessionId ?? null, run.taskId ?? null, run.trigger, startedAt);
    return this.getRun(run.id)!;
  }

  /** The chef's session id is only known once the CLI reports it. */
  setChefSession(runId: string, chefSessionId: string): void {
    this.db.prepare('UPDATE runs SET chef_session_id = ? WHERE id = ?').run(chefSessionId, runId);
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>, endedAt = this.now()): void {
    this.db
      .prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
      .run(status, endedAt, runId);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row) : undefined;
  }

  /** The most recent run with this trigger whose chef session is known, if any. */
  latestRunWithSession(trigger: RunTrigger): Run | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE trigger = ? AND chef_session_id IS NOT NULL
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(trigger);
    return row ? toRun(row) : undefined;
  }

  /** Runs of a task, oldest first. */
  runsForTask(taskId: string): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid')
      .all(taskId)
      .map(toRun);
  }

  addUsage(usage: {
    runId: string;
    tokens?: Partial<UsageTokens>;
    costUsd: number;
    recordedAt?: number;
  }): UsageRecord {
    const recordedAt = usage.recordedAt ?? this.now();
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage.tokens };
    const record: UsageRecord = {
      runId: usage.runId,
      tokens,
      costUsd: usage.costUsd,
      day: localDay(recordedAt),
      recordedAt,
    };
    this.db
      .prepare(
        `INSERT INTO usage (run_id, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, cost_usd, day, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        tokens.input,
        tokens.output,
        tokens.cacheRead,
        tokens.cacheWrite,
        record.costUsd,
        record.day,
        recordedAt,
      );
    return record;
  }

  usageForRun(runId: string): UsageRecord[] {
    return this.db
      .prepare('SELECT * FROM usage WHERE run_id = ? ORDER BY recorded_at, id')
      .all(runId)
      .map(toUsage);
  }

  /**
   * Sum of the usage recorded for every run of one chef session. A resumed run reports the
   * conversation's whole cost (headless docs), so the runner subtracts this to get its own.
   */
  usageTotalForSession(chefSessionId: string): UsageTotal {
    return this.usageTotal(
      'run_id IN (SELECT id FROM runs WHERE chef_session_id = ?)',
      chefSessionId,
    );
  }

  /** Records a session the runner owns. Recording the same one again keeps the first row. */
  addOwnedSession(owned: {
    kind: OwnedSession['kind'];
    id: string;
    runId?: string | null;
    agentType?: string | null;
    recordedAt?: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO owned_sessions (kind, id, run_id, agent_type, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        owned.kind,
        owned.id,
        owned.runId ?? null,
        owned.agentType ?? null,
        owned.recordedAt ?? this.now(),
      );
  }

  /** The owned session or subagent with this id, if any. */
  getOwnedSession(id: string, kind?: OwnedSession['kind']): OwnedSession | undefined {
    const row = kind
      ? this.db.prepare('SELECT * FROM owned_sessions WHERE kind = ? AND id = ?').get(kind, id)
      : this.db.prepare('SELECT * FROM owned_sessions WHERE id = ? ORDER BY kind').get(id);
    return row ? toOwned(row) : undefined;
  }

  /** Owned sessions, oldest first, optionally of one kind. */
  ownedSessions(kind?: OwnedSession['kind']): OwnedSession[] {
    const rows = kind
      ? this.db
          .prepare('SELECT * FROM owned_sessions WHERE kind = ? ORDER BY recorded_at, rowid')
          .all(kind)
      : this.db.prepare('SELECT * FROM owned_sessions ORDER BY recorded_at, rowid').all();
    return rows.map(toOwned);
  }

  getBrigadeConfig(): BrigadeConfig {
    const row = this.db.prepare('SELECT * FROM brigade_config WHERE id = 1').get();
    return row ? toBrigadeConfig(row) : { ...BRIGADE_DEFAULTS };
  }

  /**
   * Changes the given fields only. Validation of user input is the caller's job; the table's
   * CHECK constraints reject a non-positive cap or a negative budget.
   */
  updateBrigadeConfig(patch: BrigadeConfigPatch, updatedAt = this.now()): BrigadeConfig {
    const keys = (Object.keys(patch) as (keyof BrigadeConfigPatch)[]).filter(
      (key) => key in BRIGADE_COLUMNS && patch[key] !== undefined,
    );
    if (keys.length > 0) {
      const sets = keys.map((key) => `${BRIGADE_COLUMNS[key]} = ?`).join(', ');
      // Migration 2 inserts the row; this only guards against someone deleting it.
      this.db.prepare('INSERT OR IGNORE INTO brigade_config (id) VALUES (1)').run();
      this.db
        .prepare(`UPDATE brigade_config SET ${sets}, updated_at = ? WHERE id = 1`)
        .run(...keys.map((key) => patch[key] ?? null), updatedAt);
    }
    return this.getBrigadeConfig();
  }

  /** Total for one local day (`YYYY-MM-DD`): what the daily budget cap is checked against. */
  usageTotalForDay(day: string): UsageTotal {
    return this.usageTotal('day = ?', day);
  }

  private usageTotal(where: string, param: string): UsageTotal {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage WHERE ${where}`,
      )
      .get(param);
    return {
      tokens: {
        input: num(row?.input),
        output: num(row?.output),
        cacheRead: num(row?.cache_read),
        cacheWrite: num(row?.cache_write),
      },
      costUsd: num(row?.cost_usd),
    };
  }
}
