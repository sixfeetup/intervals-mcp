import type { Db } from "./db.js";
import { createShortLocalId } from "./local-id.js";
import type { SyncStatus } from "./types.js";

export interface TimeEntry {
  localId: string;
  remoteId?: number;
  sourceTimerId?: string;
  projectId: number;
  worktypeId: number;
  moduleId?: number;
  date: string;
  startAt?: string;
  endAt?: string;
  durationSeconds: number;
  description?: string;
  billable: boolean;
  syncStatus: SyncStatus;
  syncAttempts: number;
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InsertTimeEntryInput {
  localId: string;
  remoteId?: number;
  sourceTimerId?: string;
  projectId: number;
  worktypeId: number;
  moduleId?: number;
  date: string;
  startAt?: string;
  endAt?: string;
  durationSeconds: number;
  description?: string;
  billable?: boolean;
  syncStatus?: SyncStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateTimeEntryInput {
  projectId?: number;
  worktypeId?: number;
  moduleId?: number | null;
  date?: string;
  startAt?: string | null;
  endAt?: string | null;
  durationSeconds?: number;
  description?: string | null;
  billable?: boolean;
}

type TimeEntryRow = {
  localId: string;
  remoteId: number | null;
  sourceTimerId: string | null;
  projectId: number;
  worktypeId: number;
  moduleId: number | null;
  date: string;
  startAt: string | null;
  endAt: string | null;
  durationSeconds: number;
  description: string | null;
  billable: number;
  syncStatus: SyncStatus;
  syncAttempts: number;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
};

const selectColumns = `select
  local_id as localId,
  remote_id as remoteId,
  source_timer_id as sourceTimerId,
  project_id as projectId,
  worktype_id as worktypeId,
  module_id as moduleId,
  date,
  start_at as startAt,
  end_at as endAt,
  duration_seconds as durationSeconds,
  description,
  billable,
  sync_status as syncStatus,
  sync_attempts as syncAttempts,
  last_sync_error as lastSyncError,
  created_at as createdAt,
  updated_at as updatedAt
from time_entries`;

export class TimeEntryStore {
  constructor(private readonly db: Db) {}

  createLocalId(): string {
    return createShortLocalId((candidate) => this.getTimeEntry(candidate) != null);
  }

  resolveLocalId(localId: string): string | undefined {
    const exact = this.db.prepare("select local_id as localId from time_entries where local_id = ?").get(localId) as
      | { localId: string }
      | undefined;
    if (exact) return exact.localId;

    if (!/^[0-9a-f]{8}$/i.test(localId)) return undefined;

    const matches = this.db
      .prepare("select local_id as localId from time_entries where lower(local_id) like lower(?) order by local_id limit 2")
      .all(`${localId}%`) as Array<{ localId: string }>;
    if (matches.length === 1) return matches[0].localId;
    if (matches.length > 1) throw new Error(`time entry id is ambiguous: ${localId}`);
    return undefined;
  }

  insertTimeEntry(input: InsertTimeEntryInput): TimeEntry {
    this.db.prepare(
      `insert into time_entries (
        local_id, remote_id, source_timer_id,
        project_id, worktype_id, module_id,
        date, start_at, end_at, duration_seconds,
        description, billable, sync_status,
        sync_attempts, last_sync_error, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.localId,
      input.remoteId ?? null,
      input.sourceTimerId ?? null,
      input.projectId,
      input.worktypeId,
      input.moduleId ?? null,
      input.date,
      input.startAt ?? null,
      input.endAt ?? null,
      input.durationSeconds,
      input.description ?? null,
      input.billable === false ? 0 : 1,
      input.syncStatus ?? "pending",
      0,
      null,
      input.createdAt,
      input.updatedAt
    );
    return this.getTimeEntry(input.localId)!;
  }

  getTimeEntry(localId: string): TimeEntry | undefined {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) return undefined;
    const row = this.db.prepare(`${selectColumns} where local_id = ?`).get(resolvedLocalId) as TimeEntryRow | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  listRecent({ limit = 20 }: { limit?: number } = {}): TimeEntry[] {
    const rows = this.db.prepare(`${selectColumns} order by updated_at desc limit ?`).all(limit) as TimeEntryRow[];
    return rows.map((r) => this.mapRow(r));
  }

  findBySourceTimerId(sourceTimerId: string): TimeEntry | undefined {
    const row = this.db.prepare(`${selectColumns} where source_timer_id = ? order by updated_at desc limit 1`).get(sourceTimerId) as
      | TimeEntryRow
      | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  /**
   * Update duration without changing sync metadata. Used when normalizing
   * already-persisted entries before sending them to Intervals.
   */
  setDurationSeconds(localId: string, durationSeconds: number): void {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db
      .prepare("update time_entries set duration_seconds = ?, updated_at = ? where local_id = ?")
      .run(durationSeconds, new Date().toISOString(), resolvedLocalId);
  }

  updateTimeEntry(localId: string, patch: UpdateTimeEntryInput): TimeEntry {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);

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
    if (patch.date !== undefined) {
      sets.push("date = ?");
      params.push(patch.date);
    }
    if (patch.startAt !== undefined) {
      sets.push("start_at = ?");
      params.push(patch.startAt);
    }
    if (patch.endAt !== undefined) {
      sets.push("end_at = ?");
      params.push(patch.endAt);
    }
    if (patch.durationSeconds !== undefined) {
      sets.push("duration_seconds = ?");
      params.push(patch.durationSeconds);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.billable !== undefined) {
      sets.push("billable = ?");
      params.push(patch.billable ? 1 : 0);
    }

    sets.push("sync_status = 'pending'");
    sets.push("last_sync_error = null");

    const updatedAt = new Date().toISOString();
    sets.push("updated_at = ?");
    params.push(updatedAt);
    params.push(resolvedLocalId);

    this.db.prepare(`update time_entries set ${sets.join(", ")} where local_id = ?`).run(...params);
    const updated = this.getTimeEntry(resolvedLocalId);
    if (!updated) {
      throw new Error(`time entry not found: ${localId}`);
    }
    return updated;
  }

  deleteTimeEntry(localId: string): void {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db.prepare("delete from time_entries where local_id = ?").run(resolvedLocalId);
  }

  queryTime({ startDate, endDate, projectId }: { startDate: string; endDate: string; projectId?: number }): TimeEntry[] {
    let sql = `${selectColumns} where date between ? and ?`;
    const params: unknown[] = [startDate, endDate];
    if (projectId !== undefined) {
      sql += " and project_id = ?";
      params.push(projectId);
    }
    sql += " order by date desc, updated_at desc";
    const rows = this.db.prepare(sql).all(...params) as TimeEntryRow[];
    return rows.map((r) => this.mapRow(r));
  }

  pendingForSync(limit = 20): TimeEntry[] {
    const rows = this.db
      .prepare(`${selectColumns} where sync_status in ('pending', 'failed') order by updated_at desc limit ?`)
      .all(limit) as TimeEntryRow[];
    return rows.map((r) => this.mapRow(r));
  }

  setRemoteTime(localId: string, remoteId: number): void {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db
      .prepare(
        `update time_entries set remote_id = ?, sync_status = 'synced', sync_attempts = 0, last_sync_error = null, updated_at = ? where local_id = ?`
      )
      .run(remoteId, new Date().toISOString(), resolvedLocalId);
  }

  markSyncFailed(localId: string, error: string): void {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db
      .prepare(
        `update time_entries set sync_status = 'failed', sync_attempts = sync_attempts + 1, last_sync_error = ?, updated_at = ? where local_id = ?`
      )
      .run(error, new Date().toISOString(), resolvedLocalId);
  }

  private mapRow(row: TimeEntryRow): TimeEntry {
    return {
      localId: row.localId,
      remoteId: row.remoteId ?? undefined,
      sourceTimerId: row.sourceTimerId ?? undefined,
      projectId: row.projectId,
      worktypeId: row.worktypeId,
      moduleId: row.moduleId ?? undefined,
      date: row.date,
      startAt: row.startAt ?? undefined,
      endAt: row.endAt ?? undefined,
      durationSeconds: row.durationSeconds,
      description: row.description ?? undefined,
      billable: row.billable === 1,
      syncStatus: row.syncStatus,
      syncAttempts: row.syncAttempts,
      lastSyncError: row.lastSyncError ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
