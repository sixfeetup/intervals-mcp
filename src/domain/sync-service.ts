import type { TimeEntry, TimeEntryStore } from "./time-entry-store.js";
import { roundDurationSecondsForIntervals } from "./duration-rounding.js";
import type { CatalogStore, ProjectContextResult } from "./catalog-store.js";

export interface SyncApi {
  listResource?(resource: string, query?: Record<string, string>): Promise<unknown[]>;
  createResource(resource: string, body: Record<string, unknown>): Promise<unknown>;
  updateResource(resource: string, id: number, body: Record<string, unknown>): Promise<unknown>;
}

export interface SyncPendingOptions {
  timeRepo: TimeEntryStore;
  api: SyncApi;
  personId?: number;
  limit?: number;
  /**
   * Optional catalog store used to validate that time-entry worktype/module IDs
   * match the project's known global Intervals IDs before sending them to the
   * API. When supplied, mismatched entries fail locally with a targeted error
   * instead of relying on Intervals' generic "could not be found" response.
   */
  catalog?: CatalogStore;
  /** Called before each entry is processed; renews the sync lease during long passes. */
  renewLease?(): void;
}

export interface SyncPendingResult {
  timeEntriesCreated: number;
  timeEntriesUpdated: number;
  failed: number;
}

export async function syncPending(options: SyncPendingOptions): Promise<SyncPendingResult> {
  const { timeRepo, api, personId, limit = 20, catalog, renewLease } = options;
  const entries = timeRepo.pendingForSync(limit);

  let timeEntriesCreated = 0;
  let timeEntriesUpdated = 0;
  let failed = 0;

  for (const entry of entries) {
    renewLease?.();
    if (personId == null) {
      timeRepo.markSyncFailed(entry.localId, "Missing personId: set INTERVALS_PERSON_ID or run `intervals setup` to configure your Intervals person ID.");
      failed++;
      continue;
    }

    if (catalog) {
      const validation = validateClassification(catalog, entry.projectId, entry.worktypeId, entry.moduleId);
      if (validation) {
        timeRepo.markSyncFailed(entry.localId, validation);
        failed++;
        continue;
      }
    }

    const durationSeconds = roundDurationSecondsForIntervals(entry.durationSeconds);
    if (durationSeconds !== entry.durationSeconds) {
      timeRepo.setDurationSeconds(entry.localId, durationSeconds);
    }

    const payload: Record<string, unknown> = {
      projectid: entry.projectId,
      worktypeid: entry.worktypeId,
      personid: personId,
      date: entry.date,
      time: durationSeconds / 3600,
      description: entry.description ?? "",
      billable: entry.billable ? "t" : "f",
    };

    if (entry.moduleId != null) {
      payload.moduleid = entry.moduleId;
    }

    try {
      if (entry.remoteId == null) {
        const duplicateRemoteId = await findDuplicateRemoteTimeEntry(api, entry, personId, durationSeconds);
        if (duplicateRemoteId != null) {
          timeRepo.setRemoteTime(entry.localId, duplicateRemoteId);
          timeEntriesUpdated++;
          continue;
        }

        const response = await api.createResource("time", payload);
        const remoteId = extractRemoteId(response);
        if (remoteId != null) {
          timeRepo.setRemoteTime(entry.localId, remoteId);
        } else {
          timeRepo.markSyncFailed(entry.localId, "Could not extract remote ID from create response");
          failed++;
          continue;
        }
        timeEntriesCreated++;
      } else {
        await api.updateResource("time", entry.remoteId, payload);
        timeRepo.setRemoteTime(entry.localId, entry.remoteId);
        timeEntriesUpdated++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      timeRepo.markSyncFailed(entry.localId, sanitizeSyncError(message));
      failed++;
    }
  }

  return { timeEntriesCreated, timeEntriesUpdated, failed };
}

async function findDuplicateRemoteTimeEntry(
  api: SyncApi,
  entry: TimeEntry,
  personId: number,
  durationSeconds: number,
): Promise<number | undefined> {
  if (!api.listResource) return undefined;

  const remoteEntries = await api.listResource("time", {
    personid: String(personId),
    datebegin: entry.date,
    dateend: entry.date,
  });

  for (const remoteEntry of remoteEntries) {
    const remoteId = extractRemoteId(remoteEntry);
    if (remoteId != null && remoteEntryMatches(remoteEntry, entry, personId, durationSeconds)) {
      return remoteId;
    }
  }

  return undefined;
}

function remoteEntryMatches(remoteEntry: unknown, entry: TimeEntry, personId: number, durationSeconds: number): boolean {
  if (!remoteEntry || typeof remoteEntry !== "object") return false;
  const obj = remoteEntry as Record<string, unknown>;

  const remotePersonId = numberField(obj, "personid", "person_id");
  if (remotePersonId != null && remotePersonId !== personId) return false;

  return numberField(obj, "projectid", "project_id") === entry.projectId
    && numberField(obj, "worktypeid", "worktype_id") === entry.worktypeId
    && optionalNumberField(obj, "moduleid", "module_id") === entry.moduleId
    && stringField(obj, "date").slice(0, 10) === entry.date
    && Math.round((numberField(obj, "time") ?? NaN) * 3600) === durationSeconds
    && stringField(obj, "description") === (entry.description ?? "");
}

function numberField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toNumber(obj[key]);
    if (value != null) return value;
  }
  return undefined;
}

function optionalNumberField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (obj[key] == null || obj[key] === "") continue;
    return toNumber(obj[key]);
  }
  return undefined;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (value == null) return "";
  return String(value);
}

function validateClassification(
  catalog: CatalogStore,
  projectId: number,
  worktypeId: number,
  moduleId: number | undefined,
): string | undefined {
  const matches = catalog.searchProjectContext({ projectId, limit: 1 });
  const project: ProjectContextResult | undefined = matches[0];
  if (!project) return undefined; // Catalog not synced for this project; skip validation rather than block.

  const worktypeProblem = invalidClassificationMessage({
    kind: "worktype",
    id: worktypeId,
    valid: project.worktypes.map((w) => ({ globalId: w.worktypeId, rowId: w.id, name: w.name })),
  });
  if (worktypeProblem) return worktypeProblem;

  if (moduleId != null) {
    const moduleProblem = invalidClassificationMessage({
      kind: "module",
      id: moduleId,
      valid: project.modules.map((m) => ({ globalId: m.moduleId, rowId: m.id, name: m.name })),
    });
    if (moduleProblem) return moduleProblem;
  }

  return undefined;
}

interface ClassificationEntry {
  globalId: number | undefined;
  rowId: number;
  name: string;
}

function invalidClassificationMessage(params: {
  kind: "worktype" | "module";
  id: number;
  valid: ClassificationEntry[];
}): string | undefined {
  if (params.valid.length === 0) return undefined;
  if (params.valid.some((entry) => entry.globalId === params.id)) return undefined;

  const rowMatch = params.valid.find((entry) => entry.rowId === params.id);
  if (rowMatch && rowMatch.globalId != null) {
    return `Invalid ${params.kind}_id ${params.id}: that is a local catalog row id. Use the Intervals ${params.kind}_id ${rowMatch.globalId} (${rowMatch.name}) instead.`;
  }

  const options = params.valid
    .map((entry) => `${entry.globalId ?? entry.rowId} ${entry.name}`)
    .join(", ");
  return `Invalid ${params.kind}_id ${params.id} for this project. Expected one of: ${options}.`;
}

function extractRemoteId(response: unknown): number | undefined {
  if (response == null) return undefined;
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    const top = toNumber(obj.id);
    if (top != null) return top;
    const nested = obj.time;
    if (nested != null && typeof nested === "object") {
      const timeObj = nested as Record<string, unknown>;
      const nestedId = toNumber(timeObj.id);
      if (nestedId != null) return nestedId;
    }
  }
  return undefined;
}

function toNumber(val: unknown): number | undefined {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const parsed = Number(val);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function sanitizeSyncError(message: string): string {
  return message.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]");
}
