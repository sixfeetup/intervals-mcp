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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-time-"));
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

test("addTime uses project defaults when worktype and module omitted", () => {
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
      durationSeconds: 3600,
      description: "Defaulted work",
    });

    assert.equal(entry.projectId, 10);
    assert.equal(entry.worktypeId, 5);
    assert.equal(entry.moduleId, 7);
    assert.equal(entry.durationSeconds, 3600);
    assert.equal(entry.syncStatus, "pending");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("addTime uses project billable setting when billable is omitted", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Internal", active: true, billable: false, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [],
    });

    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Internal work",
    });

    assert.equal(entry.billable, false);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("addTime requires worktype when no project default exists", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [],
    });

    assert.throws(
      () =>
        service.addTime({
          projectId: 10,
          date: "2026-04-24",
          durationSeconds: 1800,
          description: "No default",
        }),
      /worktype is required/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("deleteTime removes a local time entry and returns the deleted entry", () => {
  const { dir, db, catalog, service, timeEntries } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [],
    });
    const entry = service.addTime({
      projectId: 10,
      worktypeId: 5,
      date: "2026-04-24",
      durationSeconds: 1800,
      description: "Delete me",
    });

    const deleted = service.deleteTime({ localId: entry.localId });

    assert.equal(deleted.localId, entry.localId);
    assert.equal(deleted.description, "Delete me");
    assert.equal(timeEntries.getTimeEntry(entry.localId), undefined);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("deleteTime rejects an unknown local time entry", () => {
  const { dir, db, service } = setup();
  try {
    assert.throws(() => service.deleteTime({ localId: "missing1" }), /time entry not found: missing1/);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("addTime rounds durationSeconds to the nearest 6 minutes", () => {
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
      durationSeconds: 113 * 60, // 1h 53m
    });

    assert.equal(entry.durationSeconds, 6840, "113 minutes rounds up to 114 minutes");
    assert.equal(entry.durationSeconds % 360, 0);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime supports today range", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [],
    });

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 3600, description: "A" });

    const report = service.queryTime({ range: "today", now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.startDate, "2026-04-24");
    assert.equal(report.endDate, "2026-04-24");
    assert.equal(report.totalSeconds, 3600);
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].projectName, "Website");
    assert.equal(report.entries[0].worktypeName, "Development");
    assert.equal(report.entries[0].moduleName, undefined);
    assert.equal(report.byProject.length, 1);
    assert.equal(report.byProject[0].projectId, 10);
    assert.equal(report.byProject[0].projectName, "Website");
    assert.equal(report.byProject[0].totalSeconds, 3600);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime supports this_week range", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, clientId: undefined, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-20", durationSeconds: 1800, description: "Mon" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-21", durationSeconds: 1800, description: "Tue" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-27", durationSeconds: 600, description: "Sun" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-19", durationSeconds: 600, description: "Prev" });

    const report = service.queryTime({ range: "this_week", now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.startDate, "2026-04-20");
    assert.equal(report.endDate, "2026-04-26");
    assert.equal(report.totalSeconds, 3600);
    assert.equal(report.entries.length, 2);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime supports last_week range", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-13", durationSeconds: 1800, description: "Mon LW" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-20", durationSeconds: 600, description: "This" });

    const report = service.queryTime({ range: "last_week", now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.startDate, "2026-04-13");
    assert.equal(report.endDate, "2026-04-19");
    assert.equal(report.totalSeconds, 1800);
    assert.equal(report.entries.length, 1);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime supports this_month range", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-01", durationSeconds: 1800, description: "First" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-30", durationSeconds: 1800, description: "Last" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-03-31", durationSeconds: 600, description: "Prev" });

    const report = service.queryTime({ range: "this_month", now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.startDate, "2026-04-01");
    assert.equal(report.endDate, "2026-04-30");
    assert.equal(report.totalSeconds, 3600);
    assert.equal(report.entries.length, 2);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime supports last_month range", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-03-15", durationSeconds: 1800, description: "LM" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-01", durationSeconds: 600, description: "This" });

    const report = service.queryTime({ range: "last_month", now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.startDate, "2026-03-01");
    assert.equal(report.endDate, "2026-03-31");
    assert.equal(report.totalSeconds, 1800);
    assert.equal(report.entries.length, 1);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime supports custom range", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-10", durationSeconds: 1800, description: "A" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-11", durationSeconds: 1800, description: "B" });
    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-12", durationSeconds: 600, description: "C" });

    const report = service.queryTime({ range: "custom", start_date: "2026-04-10", end_date: "2026-04-11" });
    assert.equal(report.startDate, "2026-04-10");
    assert.equal(report.endDate, "2026-04-11");
    assert.equal(report.totalSeconds, 3600);
    assert.equal(report.entries.length, 2);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime filters by projectId", () => {
  const { dir, db, catalog, service } = setup();
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

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 3600, description: "Website" });
    service.addTime({ projectId: 11, worktypeId: 6, date: "2026-04-24", durationSeconds: 1800, description: "App" });

    const report = service.queryTime({ range: "today", projectId: 10, now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.totalSeconds, 3600);
    assert.equal(report.entries.length, 1);
    assert.equal(report.byProject[0].projectId, 10);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime filters by projectQuery resolving unambiguous project", () => {
  const { dir, db, catalog, service } = setup();
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

    service.addTime({ projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 3600, description: "Website" });
    service.addTime({ projectId: 11, worktypeId: 6, date: "2026-04-24", durationSeconds: 1800, description: "App" });

    const report = service.queryTime({ range: "today", projectQuery: "website", now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.totalSeconds, 3600);
    assert.equal(report.entries.length, 1);
    assert.equal(report.byProject[0].projectName, "Website");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime throws when projectQuery is ambiguous", () => {
  const { dir, db, catalog, service } = setup();
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

    assert.throws(
      () => service.queryTime({ range: "today", projectQuery: "web", now: new Date("2026-04-24T12:00:00Z") }),
      /ambiguous/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime throws when projectQuery resolves nothing", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [],
      modules: [],
    });

    assert.throws(
      () => service.queryTime({ range: "today", projectQuery: "nomatch", now: new Date("2026-04-24T12:00:00Z") }),
      /no project found/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime entries include joined catalog names", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [{ id: 200, projectId: 10, moduleId: 7, name: "Backend", active: true, raw: {} }],
    });

    service.addTime({ projectId: 10, worktypeId: 5, moduleId: 7, date: "2026-04-24", durationSeconds: 3600, description: "A" });

    const report = service.queryTime({ range: "today", now: new Date("2026-04-24T12:00:00Z") });
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].projectName, "Website");
    assert.equal(report.entries[0].worktypeName, "Development");
    assert.equal(report.entries[0].moduleName, "Backend");
  } finally {
    db.close();
    teardown(dir);
  }
});

test("queryTime throws when both projectId and projectQuery are specified", () => {
  const { dir, db, catalog, service } = setup();
  try {
    catalog.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [],
      modules: [],
    });

    assert.throws(
      () => service.queryTime({ range: "today", projectId: 10, projectQuery: "web", now: new Date("2026-04-24T12:00:00Z") }),
      /cannot specify both/
    );
  } finally {
    db.close();
    teardown(dir);
  }
});
