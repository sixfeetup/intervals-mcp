import { randomBytes } from "node:crypto";
import type { CatalogStore } from "./catalog-store.js";
import { roundDurationSecondsForIntervals } from "./duration-rounding.js";
import type { ProjectDefaultsStore } from "./project-defaults-store.js";
import type { TimeEntry, TimeEntryStore } from "./time-entry-store.js";
import type { Timer, TimerStore } from "./timer-store.js";

export interface StartTimerInput {
  description: string;
  projectId?: number;
  worktypeId?: number;
  moduleId?: number;
  notes?: string;
  now?: Date;
}

export interface StopTimerInput {
  localId: string;
  projectId?: number;
  worktypeId?: number;
  moduleId?: number;
  description?: string;
  billable?: boolean;
  now?: Date;
}

export interface EditTimerInput {
  localId: string;
  projectId?: number;
  worktypeId?: number;
  moduleId?: number | null;
  description?: string;
  now?: Date;
}

export interface DeleteTimerInput {
  localId: string;
}

export class TimerService {
  constructor(
    private readonly timerStore: TimerStore,
    private readonly timeEntryStore: TimeEntryStore,
    private readonly defaultsStore: ProjectDefaultsStore,
    private readonly catalogStore: CatalogStore,
  ) {}

  startTimer(input: StartTimerInput): Timer {
    const now = input.now ?? new Date();
    const iso = now.toISOString();
    return this.timerStore.insertTimer({
      localId: this.createTimerLocalId(),
      description: input.description,
      projectId: input.projectId,
      worktypeId: input.worktypeId,
      moduleId: input.moduleId,
      notes: input.notes,
      startedAt: iso,
      createdAt: iso,
      updatedAt: iso,
    });
  }

  editTimer(input: EditTimerInput): Timer {
    const timer = this.timerStore.getTimer(input.localId);
    if (!timer) throw new Error(`timer not found: ${input.localId}`);
    if (timer.state !== "active") throw new Error(`timer is not active: ${input.localId}`);

    const projectId = input.projectId ?? timer.projectId;
    const projectChanged = input.projectId != null && input.projectId !== timer.projectId;
    const explicitModule = input.moduleId !== undefined;
    const resolved = projectId != null
      ? this.defaultsStore.resolveForProject({
          projectId,
          worktypeId: input.worktypeId ?? (projectChanged ? undefined : timer.worktypeId),
          moduleId: explicitModule ? input.moduleId ?? undefined : projectChanged ? undefined : timer.moduleId,
        })
      : { worktypeId: input.worktypeId ?? timer.worktypeId, moduleId: explicitModule ? input.moduleId ?? undefined : timer.moduleId };

    return this.timerStore.updateTimer(timer.localId, {
      projectId: input.projectId,
      worktypeId: input.worktypeId !== undefined || projectChanged ? resolved.worktypeId ?? null : undefined,
      moduleId: explicitModule ? input.moduleId : projectChanged ? resolved.moduleId ?? null : undefined,
      description: input.description,
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
  }

  deleteTimer(input: DeleteTimerInput): Timer {
    const timer = this.timerStore.getTimer(input.localId);
    if (!timer) throw new Error(`timer not found: ${input.localId}`);

    const linkedEntry = this.timeEntryStore.findBySourceTimerId(timer.localId);
    if (timer.state === "stopped" && linkedEntry) {
      throw new Error(`cannot delete stopped timer with linked time entry: ${linkedEntry.localId}`);
    }

    this.timerStore.deleteTimer(timer.localId);
    return timer;
  }

  stopTimer(input: StopTimerInput): TimeEntry {
    const timer = this.timerStore.getTimer(input.localId);
    if (!timer) throw new Error(`timer not found: ${input.localId}`);
    if (timer.state !== "active") throw new Error(`timer is not active: ${input.localId}`);

    const now = input.now ?? new Date();
    const stoppedAt = now.toISOString();
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - new Date(timer.startedAt).getTime()) / 1000));

    const projectId = input.projectId ?? timer.projectId;
    if (projectId == null) throw new Error("project is required");

    const projectChanged = input.projectId != null && input.projectId !== timer.projectId;

    const resolved = this.defaultsStore.resolveForProject({
      projectId,
      worktypeId: input.worktypeId ?? (projectChanged ? undefined : timer.worktypeId),
      moduleId: input.moduleId ?? (projectChanged ? undefined : timer.moduleId),
    });

    const worktypeId = resolved.worktypeId;
    if (worktypeId == null) throw new Error("worktype is required");

    const moduleId = resolved.moduleId;
    const projectBillable = this.catalogStore.getProject(projectId)?.billable;

    return this.timerStore.transaction(() => {
      this.timerStore.markTimerStopped(timer.localId, stoppedAt, elapsedSeconds);

      return this.timeEntryStore.insertTimeEntry({
        localId: this.timeEntryStore.createLocalId(),
        sourceTimerId: timer.localId,
        projectId,
        worktypeId,
        moduleId,
        date: formatLocalDate(new Date(timer.startedAt)),
        startAt: timer.startedAt,
        endAt: stoppedAt,
        durationSeconds: roundDurationSecondsForIntervals(elapsedSeconds),
        description: input.description ?? timer.description,
        billable: input.billable ?? projectBillable,
        createdAt: stoppedAt,
        updatedAt: stoppedAt,
      });
    });
  }

  listActive(): Timer[] {
    return this.timerStore.listActive();
  }

  private createTimerLocalId(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const localId = randomBytes(4).toString("hex");
      if (!this.timerStore.getTimer(localId)) return localId;
    }
    throw new Error("could not generate unique timer id");
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
