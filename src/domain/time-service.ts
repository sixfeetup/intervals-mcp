import type { CatalogStore } from "./catalog-store.js";
import type { Db } from "./db.js";
import { resolveDateRange } from "./date-ranges.js";
import { roundDurationSecondsForIntervals } from "./duration-rounding.js";
import { calculateDurationForLocalStopTime } from "./time-window.js";
import type { ProjectDefaultsStore } from "./project-defaults-store.js";
import type { TimeEntry, TimeEntryStore, UpdateTimeEntryInput } from "./time-entry-store.js";
import type { TimeRange } from "./types.js";

export interface AddTimeInput {
  projectId: number;
  worktypeId?: number;
  moduleId?: number;
  date: string;
  /** Duration in seconds (callers must convert minutes beforehand). */
  durationSeconds: number;
  description?: string;
  billable?: boolean;
}

export interface EditTimeInput {
  localId: string;
  projectId?: number;
  projectQuery?: string;
  worktypeId?: number;
  moduleId?: number | null;
  date?: string;
  startAt?: string | null;
  endAt?: string | null;
  /** Bare HH:mm local stop time. Recalculates endAt and durationSeconds together. */
  stopTime?: string;
  /** Duration in seconds (callers must convert minutes beforehand). */
  durationSeconds?: number;
  description?: string | null;
  billable?: boolean;
}

export interface DeleteTimeInput {
  localId: string;
}

export interface QueryTimeInput {
  range: TimeRange;
  start_date?: string;
  end_date?: string;
  projectId?: number;
  projectQuery?: string;
  now?: Date;
}

export interface TimeReportEntry extends TimeEntry {
  projectName: string;
  worktypeName: string;
  moduleName?: string;
}

export interface TimeReport {
  startDate: string;
  endDate: string;
  totalSeconds: number;
  entries: TimeReportEntry[];
  byProject: Array<{
    projectId: number;
    projectName: string;
    totalSeconds: number;
  }>;
}

export class TimeService {
  constructor(
    private readonly deps: {
      db: Db;
      timeEntryStore: TimeEntryStore;
      catalogStore: CatalogStore;
      defaultsStore: ProjectDefaultsStore;
    },
  ) {}

  addTime(input: AddTimeInput): TimeEntry {
    const resolved = this.deps.defaultsStore.resolveForProject({
      projectId: input.projectId,
      worktypeId: input.worktypeId,
      moduleId: input.moduleId,
    });

    const worktypeId = resolved.worktypeId;
    if (worktypeId == null) {
      throw new Error("worktype is required");
    }

    const now = new Date().toISOString();
    const projectBillable = this.deps.catalogStore.getProject(input.projectId)?.billable;
    return this.deps.timeEntryStore.insertTimeEntry({
      localId: this.deps.timeEntryStore.createLocalId(),
      projectId: input.projectId,
      worktypeId,
      moduleId: resolved.moduleId,
      date: input.date,
      durationSeconds: roundDurationSecondsForIntervals(input.durationSeconds),
      description: input.description,
      billable: input.billable ?? projectBillable,
      createdAt: now,
      updatedAt: now,
    });
  }

  editTime(input: EditTimeInput): TimeEntry {
    const existing = this.deps.timeEntryStore.getTimeEntry(input.localId);
    if (!existing) {
      throw new Error(`time entry not found: ${input.localId}`);
    }

    if (input.projectId != null && input.projectQuery != null) {
      throw new Error("cannot specify both projectId and projectQuery");
    }
    if (input.stopTime !== undefined && input.endAt !== undefined) {
      throw new Error("cannot specify both stopTime and endAt");
    }
    if (input.stopTime !== undefined && input.durationSeconds !== undefined) {
      throw new Error("cannot specify both stopTime and durationSeconds");
    }

    let projectId = existing.projectId;
    if (input.projectQuery != null) {
      const matches = this.deps.catalogStore.searchProjectContext({ query: input.projectQuery, limit: 5 });
      if (matches.length === 0) {
        throw new Error(`no project found for query: ${input.projectQuery}`);
      }
      if (matches.length > 1) {
        throw new Error(`project query is ambiguous: ${input.projectQuery} (${matches.length} matches)`);
      }
      projectId = matches[0].projectId;
    } else if (input.projectId !== undefined) {
      projectId = input.projectId;
    }

    const projectChanged = projectId !== existing.projectId;

    let worktypeId: number | undefined = input.worktypeId;
    if (worktypeId === undefined && projectChanged) {
      const resolved = this.deps.defaultsStore.resolveForProject({ projectId });
      if (resolved.worktypeId == null) {
        throw new Error("worktype is required");
      }
      worktypeId = resolved.worktypeId;
    }

    let moduleId: number | null | undefined = input.moduleId;
    if (moduleId === undefined && projectChanged) {
      const resolved = this.deps.defaultsStore.resolveForProject({ projectId });
      moduleId = resolved.moduleId ?? null;
    }

    let calculatedStop: ReturnType<typeof calculateDurationForLocalStopTime> | undefined;
    if (input.stopTime !== undefined) {
      calculatedStop = calculateDurationForLocalStopTime({
        date: input.date ?? existing.date,
        startAt: input.startAt === null ? undefined : input.startAt ?? existing.startAt,
        stopTime: input.stopTime,
      });
    }

    const patch: UpdateTimeEntryInput = {};
    if (projectChanged) patch.projectId = projectId;
    if (worktypeId !== undefined) patch.worktypeId = worktypeId;
    if (moduleId !== undefined) patch.moduleId = moduleId;
    if (input.date !== undefined) patch.date = input.date;
    if (input.startAt !== undefined) patch.startAt = input.startAt;
    if (calculatedStop) {
      patch.endAt = calculatedStop.endAt;
      patch.durationSeconds = roundDurationSecondsForIntervals(calculatedStop.rawDurationSeconds);
    } else {
      if (input.endAt !== undefined) patch.endAt = input.endAt;
      if (input.durationSeconds !== undefined) patch.durationSeconds = roundDurationSecondsForIntervals(input.durationSeconds);
    }
    if (input.description !== undefined) patch.description = input.description;
    if (input.billable !== undefined) patch.billable = input.billable;

    return this.deps.timeEntryStore.updateTimeEntry(input.localId, patch);
  }

  deleteTime(input: DeleteTimeInput): TimeEntry {
    const existing = this.deps.timeEntryStore.getTimeEntry(input.localId);
    if (!existing) {
      throw new Error(`time entry not found: ${input.localId}`);
    }
    this.deps.timeEntryStore.deleteTimeEntry(existing.localId);
    return existing;
  }

  queryTime(input: QueryTimeInput): TimeReport {
    if (input.projectId != null && input.projectQuery != null) {
      throw new Error("cannot specify both projectId and projectQuery");
    }

    const { startDate, endDate } = resolveDateRange({
      range: input.range,
      start_date: input.start_date,
      end_date: input.end_date,
      now: input.now,
    });

    let projectId = input.projectId;
    if (input.projectQuery != null) {
      const matches = this.deps.catalogStore.searchProjectContext({ query: input.projectQuery, limit: 5 });
      if (matches.length === 0) {
        throw new Error(`no project found for query: ${input.projectQuery}`);
      }
      if (matches.length > 1) {
        throw new Error(`project query is ambiguous: ${input.projectQuery} (${matches.length} matches)`);
      }
      projectId = matches[0].projectId;
    }

    const rawEntries = this.deps.timeEntryStore.queryTime({ startDate, endDate, projectId });
    const entries: TimeReportEntry[] = rawEntries.map((entry) => {
      const project = this.deps.catalogStore.getProject(entry.projectId);
      const worktype = this.deps.catalogStore.getWorktype(entry.projectId, entry.worktypeId);
      const mod = entry.moduleId != null ? this.deps.catalogStore.getModule(entry.projectId, entry.moduleId) : undefined;
      return {
        ...entry,
        projectName: project?.name ?? `Project ${entry.projectId}`,
        worktypeName: worktype?.name ?? `Worktype ${entry.worktypeId}`,
        moduleName: mod?.name,
      };
    });

    const projectTotals = new Map<number, { projectId: number; projectName: string; totalSeconds: number }>();
    for (const entry of entries) {
      const existing = projectTotals.get(entry.projectId);
      if (existing) {
        existing.totalSeconds += entry.durationSeconds;
      } else {
        projectTotals.set(entry.projectId, {
          projectId: entry.projectId,
          projectName: entry.projectName,
          totalSeconds: entry.durationSeconds,
        });
      }
    }

    return {
      startDate,
      endDate,
      totalSeconds: entries.reduce((sum, e) => sum + e.durationSeconds, 0),
      entries,
      byProject: Array.from(projectTotals.values()),
    };
  }
}
