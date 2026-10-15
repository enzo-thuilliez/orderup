import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Crew persistence (ADR-008, ADR-016 point 9): one SQLite file through `node:sqlite`, with
 * versioned migrations. This PR (#17) creates `runs` and `usage` only; the other ADR-016
 * tables arrive with the issues that use them, as new migrations appended below.
 */

export type Database = DatabaseSync;

/** `~/.orderup/orderup.db`. Follows `$HOME`, so tests get their temporary one. */
export function defaultDbPath(): string {
  return path.join(os.homedir(), '.orderup', 'orderup.db');
}

export interface Migration {
  version: number;
  sql: string;
}

/** Append only: never edit or reorder a migration that has shipped. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        chef_session_id TEXT,
        task_id TEXT,
        trigger TEXT NOT NULL CHECK (trigger IN ('talk', 'assign', 'send-back')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error', 'stopped'))
      );
      CREATE INDEX runs_task_id ON runs (task_id);
      CREATE INDEX runs_started_at ON runs (started_at);

      CREATE TABLE usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        day TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX usage_run_id ON usage (run_id);
      CREATE INDEX usage_day ON usage (day);
    `,
  },
];

const EXPERIMENTAL_SQLITE = /^SQLite is an experimental feature/;

/**
 * Loads `node:sqlite` lazily, dropping only its own ExperimentalWarning (ADR-008): Node prints
 * it on supported versions that still flag the module (22.x). Every other warning, from
 * `node:sqlite` or anywhere else, goes through untouched. Node emits it synchronously while
 * the module loads, so the filter is only in place for that call.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (
    this: NodeJS.Process,
    warning: string | Error,
    ...rest: unknown[]
  ) {
    const message = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type;
    const name = typeof warning === 'string' ? type : warning.name;
    if (name === 'ExperimentalWarning' && EXPERIMENTAL_SQLITE.test(message)) return;
    return (emitWarning as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Current schema version: 0 for an empty database. */
export function schemaVersion(db: Database): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
  return Number(row?.version ?? 0);
}

/**
 * Applies the pending migrations in order, each in its own transaction with its
 * `schema_version` row, so a failed migration leaves the previous version intact.
 * Re-running is a no-op. Returns the versions applied.
 */
export function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => number = Date.now,
): number[] {
  const current = schemaVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(
      `orderup.db is at schema version ${current}, newer than this OrderUp (${latest}). Update OrderUp.`,
    );
  }
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.version);
  }
  return applied;
}

/** Opens (creating it and its directory if needed) and migrates the database. */
export function openDatabase(file: string = defaultDbPath()): Database {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
