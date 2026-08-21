import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/domain/db.js";
import { TimeEntryStore } from "../src/domain/time-entry-store.js";
import { syncPending } from "../src/domain/sync-service.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-sync-"));
  const db = openDatabase(join(dir, "intervals.db"));
  const timeRepo = new TimeEntryStore(db);
  return { dir, db, timeRepo };
}

function teardown(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

function makeApi(options: {
  createResult?: unknown;
  updateResult?: unknown;
  createError?: Error;
  updateError?: Error;
}) {
  const createCalls: Array<{ resource: string; body: Record<string, unknown> }> = [];
  const updateCalls: Array<{ resource: string; id: number; body: Record<string, unknown> }> = [];

  const api = {
    createResource: async (resource: string, body: Record<string, unknown>) => {
      createCalls.push({ resource, body });
      if (options.createError) throw options.createError;
      return options.createResult ?? {};
    },
    updateResource: async (resource: string, id: number, body: Record<string, unknown>) => {
      updateCalls.push({ resource, id, body });
      if (options.updateError) throw options.updateError;
      return options.updateResult ?? {};
    },
  };

  return { api, createCalls, updateCalls };
}

test("syncPending creates unsynced pending time entries", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    const entry = timeRepo.insertTimeEntry({
      localId: "entry-1",
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      date: "2026-04-24",
      durationSeconds: 3600,
      description: "Dev work",
      billable: true,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });
    assert.equal(entry.remoteId, undefined);

    const { api, createCalls } = makeApi({ createResult: { id: 99 } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.timeEntriesCreated, 1);
    assert.equal(result.timeEntriesUpdated, 0);
    assert.equal(result.failed, 0);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].resource, "time");
    assert.deepEqual(createCalls[0].body, {
      projectid: 10,
      moduleid: 7,
      worktypeid: 5,
      personid: 3,
      date: "2026-04-24",
      time: 1,
      description: "Dev work",
      billable: "t",
    });

    const updated = timeRepo.getTimeEntry("entry-1")!;
    assert.equal(updated.remoteId, 99);
    assert.equal(updated.syncStatus, "synced");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending links an exact same-day remote time entry instead of creating a duplicate", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-dupe",
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      date: "2026-04-24",
      durationSeconds: 3600,
      description: "Dev work",
      billable: true,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const listCalls: Array<{ resource: string; query: Record<string, string> }> = [];
    let createCalls = 0;
    const api = {
      listResource: async (resource: string, query: Record<string, string>) => {
        listCalls.push({ resource, query });
        return [{
          id: 321,
          personid: 3,
          projectid: 10,
          worktypeid: 5,
          moduleid: 7,
          date: "2026-04-24",
          time: 1,
          description: "Dev work",
        }];
      },
      createResource: async () => {
        createCalls++;
        return { id: 999 };
      },
      updateResource: async () => ({}),
    };

    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.deepEqual(listCalls, [{
      resource: "time",
      query: { personid: "3", datebegin: "2026-04-24", dateend: "2026-04-24" },
    }]);
    assert.equal(createCalls, 0);
    assert.equal(result.timeEntriesCreated, 0);
    assert.equal(result.timeEntriesUpdated, 1);
    assert.equal(result.failed, 0);

    const updated = timeRepo.getTimeEntry("entry-dupe")!;
    assert.equal(updated.remoteId, 321);
    assert.equal(updated.syncStatus, "synced");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending sends unbillable pending entries as billable=f", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-unbillable",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Internal work",
      billable: false,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const { api, createCalls } = makeApi({ createResult: { id: 100 } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.failed, 0);
    assert.equal(createCalls[0].body.billable, "f");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending rounds legacy unrounded durations to 6-minute boundaries before sending", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-precise",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 6797, // 1h 53m 17s — 1.887…h — rejected by Intervals
      description: "Unrounded",
      billable: true,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const { api, createCalls } = makeApi({ createResult: { id: 99 } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.failed, 0);
    assert.equal(createCalls[0].body.time, 1.9, "sync payload uses rounded hours");

    const updated = timeRepo.getTimeEntry("entry-precise")!;
    assert.equal(updated.durationSeconds, 6840, "local row is normalized to a 6-minute boundary");
    assert.equal(updated.syncStatus, "synced");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending fails entry with clear message when catalog shows worktype_id is a local row id", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    const { CatalogStore } = await import("../src/domain/catalog-store.js");
    const catalog = new CatalogStore(db);
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Alpha", active: true, raw: {} }],
      projects: [{ id: 1447065, clientId: 1, name: "Clubhouse", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 32088213, projectId: 1447065, worktypeId: 816862, name: "Consulting", active: true, raw: {} }],
      modules: [{ id: 22457817, projectId: 1447065, moduleId: 560580, name: "foundations", active: true, raw: {} }],
    });

    timeRepo.insertTimeEntry({
      localId: "bad-wt",
      projectId: 1447065,
      worktypeId: 32088213, // project_worktypes.id instead of global 816862
      moduleId: 560580,
      date: "2026-05-01",
      durationSeconds: 3600,
      description: "Wrong worktype id",
      billable: true,
      syncStatus: "pending",
      createdAt: "2026-05-01T10:00:00Z",
      updatedAt: "2026-05-01T10:00:00Z",
    });

    const { api, createCalls } = makeApi({});
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10, catalog });

    assert.equal(createCalls.length, 0, "should not reach Intervals API with a bad worktype id");
    assert.equal(result.failed, 1);
    const row = timeRepo.getTimeEntry("bad-wt")!;
    assert.equal(row.syncStatus, "failed");
    assert.match(row.lastSyncError ?? "", /Invalid worktype_id 32088213/);
    assert.match(row.lastSyncError ?? "", /816862/);
    assert.match(row.lastSyncError ?? "", /Consulting/);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending fails entry with clear message when catalog shows module_id is a local row id", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    const { CatalogStore } = await import("../src/domain/catalog-store.js");
    const catalog = new CatalogStore(db);
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Alpha", active: true, raw: {} }],
      projects: [{ id: 1447065, clientId: 1, name: "Clubhouse", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 32088213, projectId: 1447065, worktypeId: 816862, name: "Consulting", active: true, raw: {} }],
      modules: [{ id: 22457817, projectId: 1447065, moduleId: 560580, name: "foundations", active: true, raw: {} }],
    });

    timeRepo.insertTimeEntry({
      localId: "bad-mod",
      projectId: 1447065,
      worktypeId: 816862,
      moduleId: 22457817, // project_modules.id instead of global 560580
      date: "2026-05-01",
      durationSeconds: 3600,
      description: "Wrong module id",
      billable: true,
      syncStatus: "pending",
      createdAt: "2026-05-01T10:00:00Z",
      updatedAt: "2026-05-01T10:00:00Z",
    });

    const { api, createCalls } = makeApi({});
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10, catalog });

    assert.equal(createCalls.length, 0);
    assert.equal(result.failed, 1);
    const row = timeRepo.getTimeEntry("bad-mod")!;
    assert.match(row.lastSyncError ?? "", /Invalid module_id 22457817/);
    assert.match(row.lastSyncError ?? "", /560580/);
    assert.match(row.lastSyncError ?? "", /foundations/);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending allows entries whose worktype/module IDs match the project's global Intervals IDs", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    const { CatalogStore } = await import("../src/domain/catalog-store.js");
    const catalog = new CatalogStore(db);
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Alpha", active: true, raw: {} }],
      projects: [{ id: 1447065, clientId: 1, name: "Clubhouse", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 32088213, projectId: 1447065, worktypeId: 816862, name: "Consulting", active: true, raw: {} }],
      modules: [{ id: 22457817, projectId: 1447065, moduleId: 560580, name: "foundations", active: true, raw: {} }],
    });

    timeRepo.insertTimeEntry({
      localId: "ok-entry",
      projectId: 1447065,
      worktypeId: 816862,
      moduleId: 560580,
      date: "2026-05-01",
      durationSeconds: 3600,
      description: "Correct ids",
      billable: true,
      syncStatus: "pending",
      createdAt: "2026-05-01T10:00:00Z",
      updatedAt: "2026-05-01T10:00:00Z",
    });

    const { api, createCalls } = makeApi({ createResult: { id: 42 } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10, catalog });

    assert.equal(createCalls.length, 1, "valid entry should still be sent");
    assert.equal(result.timeEntriesCreated, 1);
    assert.equal(result.failed, 0);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending updates pending time entries that have remoteId", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-2",
      remoteId: 42,
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Updated work",
      billable: false,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const { api, updateCalls } = makeApi({ updateResult: { time: { id: 42 } } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.timeEntriesCreated, 0);
    assert.equal(result.timeEntriesUpdated, 1);
    assert.equal(result.failed, 0);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].resource, "time");
    assert.equal(updateCalls[0].id, 42);
    assert.deepEqual(updateCalls[0].body, {
      projectid: 10,
      worktypeid: 5,
      personid: 3,
      date: "2026-04-24",
      time: 0.5,
      description: "Updated work",
      billable: "f",
    });

    const updated = timeRepo.getTimeEntry("entry-2")!;
    assert.equal(updated.remoteId, 42);
    assert.equal(updated.syncStatus, "synced");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending marks all rows failed when personId is missing", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-3",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      description: "No person",
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });
    timeRepo.insertTimeEntry({
      localId: "entry-3-update",
      remoteId: 42,
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      description: "No person update",
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const { api, createCalls, updateCalls } = makeApi({});
    const result = await syncPending({ timeRepo, api, personId: undefined, limit: 10 });

    assert.equal(result.timeEntriesCreated, 0);
    assert.equal(result.timeEntriesUpdated, 0);
    assert.equal(result.failed, 2);
    assert.equal(createCalls.length, 0);
    assert.equal(updateCalls.length, 0);

    const updated = timeRepo.getTimeEntry("entry-3")!;
    assert.equal(updated.syncStatus, "failed");
    assert.ok(updated.lastSyncError?.includes("personId"));

    const updateRow = timeRepo.getTimeEntry("entry-3-update")!;
    assert.equal(updateRow.syncStatus, "failed");
    assert.equal(updateRow.remoteId, 42);
    assert.ok(updateRow.lastSyncError?.includes("personId"));
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending continues after a single row failure", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-a",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      description: "Will fail",
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });
    timeRepo.insertTimeEntry({
      localId: "entry-b",
      projectId: 11,
      worktypeId: 6,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Will succeed",
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    let callCount = 0;
    const api = {
      createResource: async (_resource: string, _body: Record<string, unknown>) => {
        callCount++;
        if (callCount === 1) throw new Error("Network error");
        return { id: 77 };
      },
      updateResource: async (_resource: string, _id: number, _body: Record<string, unknown>) => {
        return {};
      },
    };

    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.timeEntriesCreated, 1);
    assert.equal(result.timeEntriesUpdated, 0);
    assert.equal(result.failed, 1);

    const failed = timeRepo.getTimeEntry("entry-a")!;
    assert.equal(failed.syncStatus, "failed");
    assert.ok(failed.lastSyncError?.includes("Network error"));

    const success = timeRepo.getTimeEntry("entry-b")!;
    assert.equal(success.remoteId, 77);
    assert.equal(success.syncStatus, "synced");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending extracts remote id from time.id wrapper", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-4",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const { api } = makeApi({ createResult: { time: { id: 55 } } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.timeEntriesCreated, 1);
    const updated = timeRepo.getTimeEntry("entry-4")!;
    assert.equal(updated.remoteId, 55);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending extracts remote id from string id", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-str",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const { api } = makeApi({ createResult: { id: "88" } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.timeEntriesCreated, 1);
    const updated = timeRepo.getTimeEntry("entry-str")!;
    assert.equal(updated.remoteId, 88);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending extracts remote id from string time.id wrapper", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-str-wrap",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const { api } = makeApi({ createResult: { time: { id: "89" } } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.timeEntriesCreated, 1);
    const updated = timeRepo.getTimeEntry("entry-str-wrap")!;
    assert.equal(updated.remoteId, 89);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending includes failed entries in retry", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-5",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      syncStatus: "failed",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });
    timeRepo.markSyncFailed("entry-5", "previous error");

    const { api } = makeApi({ createResult: { id: 88 } });
    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });

    assert.equal(result.timeEntriesCreated, 1);
    const updated = timeRepo.getTimeEntry("entry-5")!;
    assert.equal(updated.remoteId, 88);
    assert.equal(updated.syncStatus, "synced");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("syncPending redacts Basic tokens in sync errors", async () => {
  const { dir, db, timeRepo } = setup();
  try {
    timeRepo.insertTimeEntry({
      localId: "entry-redact",
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 3600,
      syncStatus: "pending",
      createdAt: "2026-04-24T10:00:00Z",
      updatedAt: "2026-04-24T10:00:00Z",
    });

    const api = {
      createResource: async () => {
        throw new Error("Request failed: Authorization: Basic dXNlcjpwYXNz");
      },
      updateResource: async () => ({ }),
    };

    const result = await syncPending({ timeRepo, api, personId: 3, limit: 10 });
    assert.equal(result.failed, 1);

    const row = timeRepo.getTimeEntry("entry-redact")!;
    assert.equal(row.syncStatus, "failed");
    assert.ok(row.lastSyncError?.includes("Basic [redacted]"));
    assert.ok(!row.lastSyncError?.includes("dXNlcjpwYXNz"));
  } finally {
    db.close();
    teardown(dir);
  }
});
