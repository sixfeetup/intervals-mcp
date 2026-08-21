import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CatalogStore } from "../src/domain/catalog-store.js";
import { openDatabase } from "../src/domain/db.js";
import { ProjectDefaultsStore } from "../src/domain/project-defaults-store.js";
import { TimeEntryStore } from "../src/domain/time-entry-store.js";
import { TimeService } from "../src/domain/time-service.js";

function localIso(year: number, monthIndex: number, day: number, hour: number, minute: number, second = 0, millisecond = 0): string {
  return new Date(year, monthIndex, day, hour, minute, second, millisecond).toISOString();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-edit-"));
  const db = openDatabase(join(dir, "intervals.db"));
  const catalog = new CatalogStore(db);
  const defaults = new ProjectDefaultsStore(db);
  const timeEntries = new TimeEntryStore(db);
  const service = new TimeService({ db, timeEntryStore: timeEntries, catalogStore: catalog, defaultsStore: defaults });
  return { dir, db, catalog, defaults, timeEntries, service };
}

function teardown(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("editTime updates duration and description and marks pending", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [{ id: 200, projectId: 10, moduleId: 7, name: "Backend", active: true, raw: {} }],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5, defaultModuleId: 7 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });
    assert.equal(entry.syncStatus, "pending");

    const edited = service.editTime({
      localId: entry.localId,
      durationSeconds: 3600,
      description: "Revised implementation work",
    });

    assert.equal(edited.durationSeconds, 3600);
    assert.equal(edited.description, "Revised implementation work");
    assert.equal(edited.syncStatus, "pending");
    assert.equal(edited.projectId, 10);
    assert.equal(edited.worktypeId, 5);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime stopTime updates endAt and rounded duration together", () => {
  const { dir, db, catalog, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 67184, name: "SFUP001 - System Administration", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 1, projectId: 67184, worktypeId: 118848, name: "Development", active: true, raw: {} }],
      modules: [{ id: 2, projectId: 67184, moduleId: 183570, name: "Internal Services - Six Feet Up", active: true, raw: {} }],
    });
    timeEntries.insertTimeEntry({
      localId: "4ee96f17",
      projectId: 67184,
      worktypeId: 118848,
      moduleId: 183570,
      date: "2026-05-05",
      startAt: localIso(2026, 4, 5, 7, 7, 43, 897),
      endAt: "2026-05-05T07:22:32.507Z",
      durationSeconds: 7920,
      billable: true,
      syncStatus: "synced",
      createdAt: "2026-05-05T05:07:43.897Z",
      updatedAt: "2026-05-05T07:22:32.507Z",
    });

    const edited = service.editTime({ localId: "4ee96f17", stopTime: "08:35" });

    assert.equal(edited.endAt, "08:35");
    assert.equal(edited.durationSeconds, 5400);
    assert.equal(edited.syncStatus, "pending");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime stopTime accepts bare local startAt overrides", () => {
  const { dir, db, catalog, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 67184, name: "SFUP001 - System Administration", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 1, projectId: 67184, worktypeId: 118848, name: "Development", active: true, raw: {} }],
      modules: [],
    });
    timeEntries.insertTimeEntry({
      localId: "4ee96f17",
      projectId: 67184,
      worktypeId: 118848,
      date: "2026-05-05",
      durationSeconds: 0,
      billable: true,
      syncStatus: "synced",
      createdAt: "2026-05-05T07:07:00.000Z",
      updatedAt: "2026-05-05T07:07:00.000Z",
    });

    const edited = service.editTime({ localId: "4ee96f17", startAt: "07:07", stopTime: "08:35" });

    assert.equal(edited.startAt, "07:07");
    assert.equal(edited.endAt, "08:35");
    assert.equal(edited.durationSeconds, 5400);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime stopTime treats earlier stop times as next-day stops", () => {
  const { dir, db, catalog, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 67184, name: "SFUP001 - System Administration", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 1, projectId: 67184, worktypeId: 118848, name: "Development", active: true, raw: {} }],
      modules: [],
    });
    timeEntries.insertTimeEntry({
      localId: "overnite",
      projectId: 67184,
      worktypeId: 118848,
      date: "2026-05-05",
      startAt: "23:30",
      durationSeconds: 0,
      billable: true,
      syncStatus: "synced",
      createdAt: "2026-05-05T23:30:00.000Z",
      updatedAt: "2026-05-05T23:30:00.000Z",
    });

    const edited = service.editTime({ localId: "overnite", stopTime: "00:30" });

    assert.equal(edited.date, "2026-05-05");
    assert.equal(edited.endAt, "00:30");
    assert.equal(edited.durationSeconds, 3600);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime rejects stopTime with explicit durationSeconds", () => {
  const { dir, db, catalog, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 67184, name: "SFUP001 - System Administration", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 1, projectId: 67184, worktypeId: 118848, name: "Development", active: true, raw: {} }],
      modules: [],
    });
    timeEntries.insertTimeEntry({
      localId: "4ee96f17",
      projectId: 67184,
      worktypeId: 118848,
      date: "2026-05-05",
      startAt: localIso(2026, 4, 5, 7, 7, 43, 897),
      durationSeconds: 7920,
      billable: true,
      syncStatus: "synced",
      createdAt: "2026-05-05T05:07:43.897Z",
      updatedAt: "2026-05-05T07:22:32.507Z",
    });

    assert.throws(
      () => service.editTime({ localId: "4ee96f17", stopTime: "08:35", durationSeconds: 1800 }),
      /cannot specify both stopTime and durationSeconds/,
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime stopTime rounds Intervals duration from rawDurationSeconds", () => {
  const { dir, db, catalog, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 67184, name: "SFUP001 - System Administration", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 1, projectId: 67184, worktypeId: 118848, name: "Development", active: true, raw: {} }],
      modules: [],
    });
    timeEntries.insertTimeEntry({
      localId: "4ee96f17",
      projectId: 67184,
      worktypeId: 118848,
      date: "2026-05-05",
      startAt: localIso(2026, 4, 5, 8, 26, 1, 0),
      durationSeconds: 0,
      billable: true,
      syncStatus: "synced",
      createdAt: "2026-05-05T08:26:01.000Z",
      updatedAt: "2026-05-05T08:26:01.000Z",
    });

    const edited = service.editTime({ localId: "4ee96f17", stopTime: "08:35" });

    assert.equal(edited.endAt, "08:35");
    assert.equal(edited.durationSeconds, 360, "raw 539s should round to 360s for Intervals");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime rounds durationSeconds to the nearest 6 minutes", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 3600,
    });

    const edited = service.editTime({
      localId: entry.localId,
      durationSeconds: 113 * 60,
    });

    assert.equal(edited.durationSeconds, 6840);
    assert.equal(edited.durationSeconds % 360, 0);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime preserves remoteId and marks syncStatus pending", () => {
  const { dir, db, catalog, defaults, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    timeEntries.setRemoteTime(entry.localId, 999);
    const synced = timeEntries.getTimeEntry(entry.localId)!;
    assert.equal(synced.remoteId, 999);
    assert.equal(synced.syncStatus, "synced");

    const edited = service.editTime({
      localId: entry.localId,
      durationSeconds: 3600,
    });

    assert.equal(edited.remoteId, 999);
    assert.equal(edited.syncStatus, "pending");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime clears lastSyncError on edit", () => {
  const { dir, db, catalog, defaults, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    timeEntries.markSyncFailed(entry.localId, "network timeout");
    const failed = timeEntries.getTimeEntry(entry.localId)!;
    assert.equal(failed.syncStatus, "failed");
    assert.equal(failed.lastSyncError, "network timeout");

    const edited = service.editTime({
      localId: entry.localId,
      description: "Fixed",
    });

    assert.equal(edited.syncStatus, "pending");
    assert.equal(edited.lastSyncError, undefined);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime updates updated_at", async () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    await new Promise((r) => setTimeout(r, 15));

    const edited = service.editTime({
      localId: entry.localId,
      durationSeconds: 3600,
    });

    assert.ok(edited.updatedAt > entry.updatedAt, "updated_at should increase");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime resolves projectQuery to unambiguous project", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [
        { id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} },
        { id: 11, clientId: 1, name: "App", active: true, billable: true, raw: {} },
      ],
      worktypes: [
        { id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} },
        { id: 101, projectId: 11, worktypeId: 6, name: "Design", active: true, raw: {} },
      ],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });
    defaults.setProjectDefaults({ projectId: 11, defaultWorktypeId: 6 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    const edited = service.editTime({
      localId: entry.localId,
      projectQuery: "app",
    });

    assert.equal(edited.projectId, 11);
    assert.equal(edited.worktypeId, 6);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime throws when projectQuery is ambiguous", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [
        { id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} },
        { id: 11, clientId: 1, name: "Web App", active: true, billable: true, raw: {} },
      ],
      worktypes: [],
      modules: [],
    });

    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    assert.throws(
      () => service.editTime({ localId: entry.localId, projectQuery: "web" }),
      /ambiguous/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime throws when projectQuery resolves nothing", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [],
      modules: [],
    });

    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    assert.throws(
      () => service.editTime({ localId: entry.localId, projectQuery: "nomatch" }),
      /no project found/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime uses new project default worktype when project changes and worktypeId omitted", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [
        { id: 10, name: "Website", active: true, billable: true, raw: {} },
        { id: 11, name: "App", active: true, billable: true, raw: {} },
      ],
      worktypes: [
        { id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} },
        { id: 101, projectId: 11, worktypeId: 6, name: "Design", active: true, raw: {} },
      ],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 11, defaultWorktypeId: 6 });

    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    const edited = service.editTime({
      localId: entry.localId,
      projectId: 11,
    });

    assert.equal(edited.projectId, 11);
    assert.equal(edited.worktypeId, 6);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime throws worktype is required when project changes and no default exists", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [
        { id: 10, name: "Website", active: true, billable: true, raw: {} },
        { id: 11, name: "App", active: true, billable: true, raw: {} },
      ],
      worktypes: [
        { id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} },
        { id: 101, projectId: 11, worktypeId: 6, name: "Design", active: true, raw: {} },
      ],
      modules: [],
    });
    // No defaults for project 11

    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    assert.throws(
      () => service.editTime({ localId: entry.localId, projectId: 11 }),
      /worktype is required/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime allows explicit worktypeId when project changes", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [
        { id: 10, name: "Website", active: true, billable: true, raw: {} },
        { id: 11, name: "App", active: true, billable: true, raw: {} },
      ],
      worktypes: [
        { id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} },
        { id: 101, projectId: 11, worktypeId: 6, name: "Design", active: true, raw: {} },
      ],
      modules: [],
    });

    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    const edited = service.editTime({
      localId: entry.localId,
      projectId: 11,
      worktypeId: 6,
    });

    assert.equal(edited.projectId, 11);
    assert.equal(edited.worktypeId, 6);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime allows null moduleId to clear module", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [{ id: 200, projectId: 10, moduleId: 7, name: "Backend", active: true, raw: {} }],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5, defaultModuleId: 7 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });
    assert.equal(entry.moduleId, 7);

    const edited = service.editTime({
      localId: entry.localId,
      moduleId: null,
    });

    assert.equal(edited.moduleId, undefined);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime allows all editable fields at once", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [
        { id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} },
        { id: 11, clientId: 1, name: "App", active: true, billable: true, raw: {} },
      ],
      worktypes: [
        { id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} },
        { id: 101, projectId: 11, worktypeId: 6, name: "Design", active: true, raw: {} },
      ],
      modules: [
        { id: 200, projectId: 10, moduleId: 7, name: "Backend", active: true, raw: {} },
        { id: 201, projectId: 11, moduleId: 8, name: "Frontend", active: true, raw: {} },
      ],
    });
    defaults.setProjectDefaults({ projectId: 11, defaultWorktypeId: 6, defaultModuleId: 8 });

    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
      billable: true,
    });

    const edited = service.editTime({
      localId: entry.localId,
      projectId: 11,
      worktypeId: 6,
      moduleId: 8,
      date: "2026-04-25",
      startAt: "10:00",
      endAt: "11:00",
      durationSeconds: 3600,
      description: "Revised",
      billable: false,
    });

    assert.equal(edited.projectId, 11);
    assert.equal(edited.worktypeId, 6);
    assert.equal(edited.moduleId, 8);
    assert.equal(edited.date, "2026-04-25");
    assert.equal(edited.startAt, "10:00");
    assert.equal(edited.endAt, "11:00");
    assert.equal(edited.durationSeconds, 3600);
    assert.equal(edited.description, "Revised");
    assert.equal(edited.billable, false);
    assert.equal(edited.syncStatus, "pending");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime clears moduleId when changing to a project without a default module", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [
        { id: 10, name: "Website", active: true, billable: true, raw: {} },
        { id: 11, name: "App", active: true, billable: true, raw: {} },
      ],
      worktypes: [
        { id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} },
        { id: 101, projectId: 11, worktypeId: 6, name: "Design", active: true, raw: {} },
      ],
      modules: [
        { id: 200, projectId: 10, moduleId: 7, name: "Backend", active: true, raw: {} },
      ],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5, defaultModuleId: 7 });
    defaults.setProjectDefaults({ projectId: 11, defaultWorktypeId: 6 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });
    assert.equal(entry.moduleId, 7);

    const edited = service.editTime({
      localId: entry.localId,
      projectId: 11,
    });

    assert.equal(edited.projectId, 11);
    assert.equal(edited.moduleId, undefined);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime throws when both projectId and projectQuery are provided", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });

    const entry = service.addTime({
      projectId: 10,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Initial",
    });

    assert.throws(
      () => service.editTime({ localId: entry.localId, projectId: 11, projectQuery: "app" }),
      /cannot specify both projectId and projectQuery/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("addTime creates an 8-character local time entry id", () => {
  const { dir, db, catalog, defaults, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });
    defaults.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });

    const entry = service.addTime({ projectId: 10, date: "2026-04-24", durationSeconds: 1800 });

    assert.match(entry.localId, /^[0-9a-f]{8}$/);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("editTime resolves legacy UUID entries by unique 8-character prefix", () => {
  const { dir, db, catalog, timeEntries, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });
    timeEntries.insertTimeEntry({
      localId: "4ee96f17-0374-4d1b-a92a-05956213a007",
      projectId: 10,
      worktypeId: 5,
      date: "2026-05-05",
      durationSeconds: 7920,
      billable: true,
      createdAt: "2026-05-05T07:07:43.897Z",
      updatedAt: "2026-05-05T07:07:43.897Z",
    });

    const edited = service.editTime({ localId: "4ee96f17", durationSeconds: 1800 });

    assert.equal(edited.localId, "4ee96f17-0374-4d1b-a92a-05956213a007");
    assert.equal(edited.durationSeconds, 1800);
  } finally {
    db.close();
    teardown(dir);
  }
});
