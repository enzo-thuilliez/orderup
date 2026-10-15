import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultDbPath,
  localDay,
  migrate,
  MIGRATIONS,
  openDatabase,
  Repository,
  schemaVersion,
  type Database,
} from '../src/persistence/index.js';

const open: Database[] = [];

function tempDb(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'orderup-db-')), 'orderup.db');
}

function track(db: Database): Database {
  open.push(db);
  return db;
}

function tables(db: Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
    .sort();
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('database', () => {
  it('lives in ~/.orderup under the current HOME', () => {
    expect(defaultDbPath()).toBe(path.join(os.homedir(), '.orderup', 'orderup.db'));
  });

  it('creates the database, its directory and the V1 tables on a fresh install', () => {
    const file = defaultDbPath();
    expect(existsSync(file)).toBe(false);
    const db = track(openDatabase());
    expect(existsSync(file)).toBe(true);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    // Only runs and usage: the other ADR-016 tables land with their own issues.
    expect(tables(db)).toEqual(['runs', 'schema_version', 'usage']);
  });

  it('re-running migrations is a no-op', () => {
    const file = tempDb();
    const db = track(openDatabase(file));
    new Repository(db).startRun({ id: 'r1', trigger: 'talk', startedAt: 1 });
    const before = db.prepare('SELECT * FROM schema_version').all();

    expect(migrate(db)).toEqual([]);
    db.close();
    open.pop();

    const reopened = track(openDatabase(file));
    expect(reopened.prepare('SELECT * FROM schema_version').all()).toEqual(before);
    expect(new Repository(reopened).getRun('r1')?.trigger).toBe('talk');
  });

  it('applies only the pending migrations, in order', () => {
    const db = track(openDatabase(tempDb()));
    const next = [...MIGRATIONS, { version: 99, sql: 'CREATE TABLE extra (x INTEGER)' }];
    expect(migrate(db, next)).toEqual([99]);
    expect(schemaVersion(db)).toBe(99);
    expect(migrate(db, next)).toEqual([]);
  });

  it('rolls back a failing migration and keeps the previous version', () => {
    const db = track(openDatabase(tempDb()));
    const broken = [
      ...MIGRATIONS,
      { version: 99, sql: 'CREATE TABLE half (x INTEGER); SELECT * FROM missing_table' },
    ];
    expect(() => migrate(db, broken)).toThrow(/missing_table/);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(tables(db)).not.toContain('half');
  });

  it('refuses a database from a newer OrderUp', () => {
    const db = track(openDatabase(tempDb()));
    expect(() => migrate(db, MIGRATIONS.slice(0, 0))).toThrow(/newer than this OrderUp/);
  });

  it('silences only the node:sqlite ExperimentalWarning', () => {
    const script = `
      process.on('warning', (w) => console.log('WARN ' + w.name + ': ' + w.message));
      const { openDatabase } = await import(${JSON.stringify(path.join(import.meta.dirname, '../src/persistence/db.ts'))});
      openDatabase(':memory:').close();
      process.emitWarning('still here', 'ExperimentalWarning');
    `;
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).not.toMatch(/SQLite/);
    expect(output).toContain('WARN ExperimentalWarning: still here');
  });
});

describe('Repository', () => {
  function setup() {
    let now = Date.UTC(2026, 9, 15, 12);
    const db = track(openDatabase(tempDb()));
    return { repo: new Repository(db, () => now), db, setNow: (t: number) => (now = t) };
  }

  it('inserts and reads runs', () => {
    const { repo, setNow } = setup();
    const started = repo.startRun({ id: 'r1', trigger: 'assign', taskId: 't1' });
    expect(started).toEqual({
      id: 'r1',
      chefSessionId: null,
      taskId: 't1',
      trigger: 'assign',
      startedAt: Date.UTC(2026, 9, 15, 12),
      endedAt: null,
      status: 'running',
    });

    repo.setChefSession('r1', 'session-1');
    setNow(Date.UTC(2026, 9, 15, 13));
    repo.endRun('r1', 'success');
    repo.startRun({ id: 'r2', trigger: 'send-back', taskId: 't1', chefSessionId: 'session-1' });

    expect(repo.getRun('r1')).toMatchObject({
      chefSessionId: 'session-1',
      endedAt: Date.UTC(2026, 9, 15, 13),
      status: 'success',
    });
    expect(repo.runsForTask('t1').map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(repo.getRun('nope')).toBeUndefined();
  });

  it('rejects unknown triggers and usage for unknown runs', () => {
    const { repo } = setup();
    expect(() => repo.startRun({ id: 'r1', trigger: 'stop' as never })).toThrow(/CHECK/);
    expect(() => repo.addUsage({ runId: 'ghost', costUsd: 1 })).toThrow(/FOREIGN KEY/);
  });

  it('records usage per run with tokens and API-equivalent USD', () => {
    const { repo } = setup();
    repo.startRun({ id: 'r1', trigger: 'talk' });
    repo.addUsage({ runId: 'r1', tokens: { input: 10, output: 20 }, costUsd: 0.5 });
    repo.addUsage({
      runId: 'r1',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      costUsd: 0.25,
    });
    const rows = repo.usageForRun('r1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      runId: 'r1',
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.5,
      day: localDay(Date.UTC(2026, 9, 15, 12)),
      recordedAt: Date.UTC(2026, 9, 15, 12),
    });
  });

  it('totals usage per local day for the budget cap', () => {
    const { repo } = setup();
    repo.startRun({ id: 'r1', trigger: 'talk' });
    repo.startRun({ id: 'r2', trigger: 'assign' });
    const day1 = new Date(2026, 9, 15, 9).getTime();
    const day2 = new Date(2026, 9, 16, 0, 30).getTime();
    repo.addUsage({ runId: 'r1', tokens: { input: 100 }, costUsd: 1.25, recordedAt: day1 });
    repo.addUsage({ runId: 'r2', tokens: { output: 50 }, costUsd: 2, recordedAt: day1 + 1000 });
    repo.addUsage({ runId: 'r2', tokens: { cacheRead: 7 }, costUsd: 4, recordedAt: day2 });

    expect(repo.usageTotalForDay('2026-10-15')).toEqual({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      costUsd: 3.25,
    });
    expect(repo.usageTotalForDay('2026-10-16').costUsd).toBe(4);
    expect(repo.usageTotalForDay('2026-10-17')).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
    });
  });
});

describe('localDay', () => {
  it('formats the local calendar day', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
  });
});
