import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type StatementSyncType = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
};

type DatabaseSyncInstance = {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncType;
  close(): void;
};

type DatabaseConstructor = new (path: string) => DatabaseSyncInstance;
type SqliteModule = { DatabaseSync?: DatabaseConstructor; Database?: DatabaseConstructor };
type ImportModule = (specifier: string) => Promise<SqliteModule>;

const importModule: ImportModule = (specifier) => import(specifier) as Promise<SqliteModule>;

export async function resolveDatabaseConstructor(importer: ImportModule = importModule): Promise<DatabaseConstructor> {
  try {
    const nodeSqlite = await importer("node:sqlite");
    if (nodeSqlite.DatabaseSync) return nodeSqlite.DatabaseSync;
  } catch (error) {
    const bunSqlite = await importer("bun:sqlite");
    if (bunSqlite.Database) return bunSqlite.Database;
    throw error;
  }

  const bunSqlite = await importer("bun:sqlite");
  if (bunSqlite.Database) return bunSqlite.Database;
  throw new Error("No supported SQLite runtime is available");
}

// Suppress node:sqlite ExperimentalWarning before first import.
const originalEmitWarning = process.emitWarning as (...args: unknown[]) => void;
process.emitWarning = (warning: string | Error, ...args: unknown[]) => {
  const msg =
    typeof warning === "string"
      ? warning
      : "message" in warning
        ? warning.message
        : "";
  if (msg.includes("SQLite is an experimental feature")) return;
  originalEmitWarning.call(process, warning, ...args);
};

const DatabaseSync = await resolveDatabaseConstructor();

export interface RunResult {
  lastInsertRowid: number;
  changes: number;
}

export interface Statement {
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
  run(...params: unknown[]): RunResult;
}

export interface Db {
  open: boolean;
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

class DbCompat implements Db {
  open = true;
  private db: DatabaseSyncInstance;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt = this.db.prepare(sql);
    return new StatementCompat(stmt);
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec("BEGIN");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    };
  }

  close(): void {
    if (this.open) {
      this.db.close();
      this.open = false;
    }
  }
}

class StatementCompat implements Statement {
  constructor(private stmt: StatementSyncType) {}

  get<T = unknown>(...params: unknown[]): T | undefined {
    return this.stmt.get(...params) as T | undefined;
  }

  all<T = unknown>(...params: unknown[]): T[] {
    return this.stmt.all(...params) as T[];
  }

  run(...params: unknown[]): RunResult {
    const result = this.stmt.run(...params);
    return {
      lastInsertRowid: Number(result.lastInsertRowid),
      changes: Number(result.changes),
    };
  }
}

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DbCompat(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    create table if not exists settings (
      key text primary key,
      value text not null,
      updated_at text not null
    );

    create table if not exists clients (
      id integer primary key,
      name text not null,
      active integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists projects (
      id integer primary key,
      client_id integer,
      name text not null,
      active integer,
      billable integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists project_worktypes (
      id integer primary key,
      project_id integer not null,
      worktype_id integer,
      name text not null,
      active integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists project_modules (
      id integer primary key,
      project_id integer not null,
      module_id integer,
      name text not null,
      active integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists project_defaults (
      project_id integer primary key,
      default_worktype_id integer,
      default_module_id integer,
      updated_at text not null
    );

    create table if not exists timers (
      local_id text primary key,
      project_id integer,
      worktype_id integer,
      module_id integer,
      description text not null,
      notes text,
      started_at text not null,
      stopped_at text,
      elapsed_seconds integer not null default 0,
      state text not null check (state in ('active', 'stopped')),
      created_at text not null,
      updated_at text not null
    );

    create table if not exists time_entries (
      local_id text primary key,
      remote_id integer,
      source_timer_id text,
      project_id integer not null,
      worktype_id integer not null,
      module_id integer,
      date text not null,
      start_at text,
      end_at text,
      duration_seconds integer not null,
      description text,
      billable integer not null default 1,
      sync_status text not null check (sync_status in ('pending', 'synced', 'failed', 'needs_review')),
      sync_attempts integer not null default 0,
      last_sync_error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists idx_timers_state on timers(state);
    create index if not exists idx_time_entries_date on time_entries(date);
    create index if not exists idx_time_entries_project on time_entries(project_id);
    create index if not exists idx_time_entries_sync on time_entries(sync_status);
  `);
}
