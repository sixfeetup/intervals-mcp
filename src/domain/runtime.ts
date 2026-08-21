import { startBackgroundSync, type BackgroundSyncHandle } from "./background-sync.js";
import { CatalogStore } from "./catalog-store.js";
import {
  databasePath,
  getIntervalsHome,
  loadConfig,
  resolveCredentials,
  resolvePersonId,
} from "./config.js";
import { syncProjectsCatalog } from "./catalog-sync.js";
import { openDatabase, type Db } from "./db.js";
import { IntervalsApiClient } from "./intervals-api.js";
import { ProjectDefaultsStore } from "./project-defaults-store.js";
import { syncPending } from "./sync-service.js";
import { TimeEntryStore, type TimeEntry } from "./time-entry-store.js";
import { TimeService } from "./time-service.js";
import { TimerService } from "./timer-service.js";
import { TimerStore } from "./timer-store.js";

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  syncIntervalMs?: number;
}

export interface RuntimeStatus {
  home: string;
  credentialsConfigured: boolean;
  credentialSource?: "env" | "config";
  dbOpen: boolean;
  personId?: number;
  apiClient?: boolean;
  backgroundSyncRunning?: boolean;
}

export interface Runtime {
  status(): RuntimeStatus;
  close(): void;
  trySyncNow(): Promise<{ timeEntriesCreated: number; timeEntriesUpdated: number; failed: number }>;
  deleteTimeEntry(localId: string): Promise<TimeEntry>;
  syncProjectsCatalog(): Promise<{ clients: number; projects: number; worktypes: number; modules: number }>;
  reloadCredentials(): void;
  catalogStore: CatalogStore;
  defaultsStore: ProjectDefaultsStore;
  timerStore: TimerStore;
  timeEntryStore: TimeEntryStore;
  timerService: TimerService;
  timeService: TimeService;
  syncService: { syncPending: typeof syncPending };
}

const DEFAULT_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const home = getIntervalsHome(env);
  let config = loadConfig(home);
  let credentials = resolveCredentials(config, env);
  let personId = resolvePersonId(config, env);

  const db = openDatabase(databasePath(home));
  const catalogStore = new CatalogStore(db);
  const defaultsStore = new ProjectDefaultsStore(db);
  const timerStore = new TimerStore(db);
  const timeEntryStore = new TimeEntryStore(db);

  let apiClient = credentials
    ? new IntervalsApiClient({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl })
    : undefined;

  const timerService = new TimerService(timerStore, timeEntryStore, defaultsStore, catalogStore);
  const timeService = new TimeService({
    db,
    timeEntryStore,
    catalogStore,
    defaultsStore,
  });

  const syncService = {
    syncPending,
  };

  async function trySyncNow(): Promise<{ timeEntriesCreated: number; timeEntriesUpdated: number; failed: number }> {
    if (!apiClient || !personId) {
      return { timeEntriesCreated: 0, timeEntriesUpdated: 0, failed: 0 };
    }
    return syncPending({
      timeRepo: timeEntryStore,
      api: apiClient,
      personId,
      limit: 50,
      catalog: catalogStore,
    });
  }

  async function deleteTimeEntry(localId: string): Promise<TimeEntry> {
    const entry = timeEntryStore.getTimeEntry(localId);
    if (!entry) throw new Error(`time entry not found: ${localId}`);
    if (entry.remoteId != null) {
      if (!apiClient) {
        throw new Error("cannot delete synced time entry without Intervals credentials configured");
      }
      await apiClient.deleteResource("time", entry.remoteId);
    }
    return timeService.deleteTime({ localId: entry.localId });
  }

  async function syncProjectsCatalogNow(): Promise<{ clients: number; projects: number; worktypes: number; modules: number }> {
    if (!apiClient) {
      throw new Error("Intervals credentials are not configured");
    }
    return syncProjectsCatalog(apiClient, catalogStore);
  }

  let backgroundSync: BackgroundSyncHandle | undefined;

  function startBackgroundSyncIfReady(): void {
    if (backgroundSync) return;
    if (!apiClient || !personId) return;
    const effectiveIntervalMs = options.syncIntervalMs ?? config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    backgroundSync = startBackgroundSync({
      intervalMs: effectiveIntervalMs,
      syncNow: trySyncNow,
      onError: (_error) => {
        // Silent by default; errors are stored per-row in the database.
      },
    });
  }

  function stopBackgroundSync(): void {
    backgroundSync?.stop();
    backgroundSync = undefined;
  }

  function reloadCredentials(): void {
    config = loadConfig(home);
    credentials = resolveCredentials(config, env);
    personId = resolvePersonId(config, env);
    apiClient = credentials
      ? new IntervalsApiClient({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl })
      : undefined;
    stopBackgroundSync();
    startBackgroundSyncIfReady();
  }

  function status(): RuntimeStatus {
    return {
      home,
      credentialsConfigured: credentials != null,
      credentialSource: credentials?.source,
      dbOpen: db.open,
      personId: personId ?? undefined,
      apiClient: apiClient != null,
      backgroundSyncRunning: backgroundSync != null,
    };
  }

  function close(): void {
    stopBackgroundSync();
    if (db.open) {
      db.close();
    }
  }

  startBackgroundSyncIfReady();

  return {
    status,
    close,
    trySyncNow,
    deleteTimeEntry,
    syncProjectsCatalog: syncProjectsCatalogNow,
    reloadCredentials,
    catalogStore,
    defaultsStore,
    timerStore,
    timeEntryStore,
    timerService,
    timeService,
    syncService,
  };
}
