import type { Db } from "./db.js";
import type { TimerState } from "./types.js";

export interface Timer {
  localId: string;
  projectId?: number;
  worktypeId?: number;
  moduleId?: number;
  description: string;
  notes?: string;
  startedAt: string;
  stoppedAt?: string;
  elapsedSeconds: number;
  state: TimerState;
  createdAt: string;
  updatedAt: string;
}

export interface InsertTimerInput {
  localId: string;
  projectId?: number;
  worktypeId?: number;
  moduleId?: number;
  description: string;
  notes?: string;
  startedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateTimerInput {
  projectId?: number | null;
  worktypeId?: number | null;
  moduleId?: number | null;
  description?: string;
  notes?: string | null;
  updatedAt: string;
}

export class TimerStore {
  constructor(private readonly db: Db) {}

  insertTimer(input: InsertTimerInput): Timer {
    this.db.prepare(
      `insert into timers (
        local_id, project_id, worktype_id, module_id,
        description, notes, started_at, stopped_at,
        elapsed_seconds, state, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.localId,
      input.projectId ?? null,
      input.worktypeId ?? null,
      input.moduleId ?? null,
      input.description,
      input.notes ?? null,
      input.startedAt,
      null,
      0,
      "active",
      input.createdAt,
      input.updatedAt
    );
    return this.getTimer(input.localId)!;
  }

  getTimer(localId: string): Timer | undefined {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) return undefined;

    const row = this.db.prepare(
      `select
        local_id as localId,
        project_id as projectId,
        worktype_id as worktypeId,
        module_id as moduleId,
        description,
        notes,
        started_at as startedAt,
        stopped_at as stoppedAt,
        elapsed_seconds as elapsedSeconds,
        state,
        created_at as createdAt,
        updated_at as updatedAt
      from timers where local_id = ?`
    ).get(resolvedLocalId) as
      | {
          localId: string;
          projectId: number | null;
          worktypeId: number | null;
          moduleId: number | null;
          description: string;
          notes: string | null;
          startedAt: string;
          stoppedAt: string | null;
          elapsedSeconds: number;
          state: TimerState;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  listActive(): Timer[] {
    const rows = this.db.prepare(
      `select
        local_id as localId,
        project_id as projectId,
        worktype_id as worktypeId,
        module_id as moduleId,
        description,
        notes,
        started_at as startedAt,
        stopped_at as stoppedAt,
        elapsed_seconds as elapsedSeconds,
        state,
        created_at as createdAt,
        updated_at as updatedAt
      from timers where state = 'active' order by started_at desc`
    ).all() as Array<{
      localId: string;
      projectId: number | null;
      worktypeId: number | null;
      moduleId: number | null;
      description: string;
      notes: string | null;
      startedAt: string;
      stoppedAt: string | null;
      elapsedSeconds: number;
      state: TimerState;
      createdAt: string;
      updatedAt: string;
    }>;
    return rows.map((r) => this.mapRow(r));
  }

  listRecent(limit = 20): Timer[] {
    const rows = this.db.prepare(
      `select
        local_id as localId,
        project_id as projectId,
        worktype_id as worktypeId,
        module_id as moduleId,
        description,
        notes,
        started_at as startedAt,
        stopped_at as stoppedAt,
        elapsed_seconds as elapsedSeconds,
        state,
        created_at as createdAt,
        updated_at as updatedAt
      from timers order by updated_at desc limit ?`
    ).all(limit) as Array<{
      localId: string;
      projectId: number | null;
      worktypeId: number | null;
      moduleId: number | null;
      description: string;
      notes: string | null;
      startedAt: string;
      stoppedAt: string | null;
      elapsedSeconds: number;
      state: TimerState;
      createdAt: string;
      updatedAt: string;
    }>;
    return rows.map((r) => this.mapRow(r));
  }

  updateTimer(localId: string, patch: UpdateTimerInput): Timer {
    const resolvedLocalId = this.resolveLocalId(localId) ?? localId;
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.projectId !== undefined) {
      sets.push("project_id = ?");
      params.push(patch.projectId);
    }
    if (patch.worktypeId !== undefined) {
      sets.push("worktype_id = ?");
      params.push(patch.worktypeId);
    }
    if (patch.moduleId !== undefined) {
      sets.push("module_id = ?");
      params.push(patch.moduleId);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.notes !== undefined) {
      sets.push("notes = ?");
      params.push(patch.notes);
    }

    sets.push("updated_at = ?");
    params.push(patch.updatedAt, resolvedLocalId);

    this.db.prepare(`update timers set ${sets.join(", ")} where local_id = ?`).run(...params);
    const updated = this.getTimer(resolvedLocalId);
    if (!updated) throw new Error(`timer not found: ${localId}`);
    return updated;
  }

  markTimerStopped(localId: string, stoppedAt: string, elapsedSeconds: number): void {
    const resolvedLocalId = this.resolveLocalId(localId) ?? localId;
    this.db.prepare(
      `update timers set
        stopped_at = ?,
        elapsed_seconds = ?,
        state = 'stopped',
        updated_at = ?
      where local_id = ?`
    ).run(stoppedAt, elapsedSeconds, stoppedAt, resolvedLocalId);
  }

  deleteTimer(localId: string): void {
    const resolvedLocalId = this.resolveLocalId(localId) ?? localId;
    this.db.prepare("delete from timers where local_id = ?").run(resolvedLocalId);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private mapRow(row: {
    localId: string;
    projectId: number | null;
    worktypeId: number | null;
    moduleId: number | null;
    description: string;
    notes: string | null;
    startedAt: string;
    stoppedAt: string | null;
    elapsedSeconds: number;
    state: TimerState;
    createdAt: string;
    updatedAt: string;
  }): Timer {
    return {
      localId: row.localId,
      projectId: row.projectId ?? undefined,
      worktypeId: row.worktypeId ?? undefined,
      moduleId: row.moduleId ?? undefined,
      description: row.description,
      notes: row.notes ?? undefined,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt ?? undefined,
      elapsedSeconds: row.elapsedSeconds,
      state: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private resolveLocalId(localId: string): string | undefined {
    const exact = this.db.prepare("select local_id as localId from timers where local_id = ?").get(localId) as
      | { localId: string }
      | undefined;
    if (exact) return exact.localId;

    if (!/^[0-9a-f]{8}$/i.test(localId)) return undefined;

    const matches = this.db
      .prepare("select local_id as localId from timers where local_id like ? order by local_id limit 2")
      .all(`${localId}%`) as Array<{ localId: string }>;
    if (matches.length === 1) return matches[0].localId;
    if (matches.length > 1) throw new Error(`timer id is ambiguous: ${localId}`);
    return undefined;
  }
}
