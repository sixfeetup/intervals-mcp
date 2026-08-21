import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/domain/db.js";
import { TimerStore } from "../src/domain/timer-store.js";
import { TimeEntryStore } from "../src/domain/time-entry-store.js";
import { ProjectDefaultsStore } from "../src/domain/project-defaults-store.js";
import { CatalogStore } from "../src/domain/catalog-store.js";
import { TimerService } from "../src/domain/timer-service.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-timer-"));
  const db = openDatabase(join(dir, "intervals.db"));
  const timerStore = new TimerStore(db);
  const timeEntryStore = new TimeEntryStore(db);
  const defaultsStore = new ProjectDefaultsStore(db);
  const catalogStore = new CatalogStore(db);
  const service = new TimerService(timerStore, timeEntryStore, defaultsStore, catalogStore);
  return { dir, db, timerStore, timeEntryStore, service, defaultsStore, catalogStore };
}

function teardown(dir: string, db: ReturnType<typeof openDatabase>) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

test("startTimer requires only description and creates active timer", () => {
  const { dir, db, timerStore, service } = setup();
  try {
    const timer = service.startTimer({ description: "Work on feature", now: new Date("2026-04-24T10:00:00Z") });
    assert.ok(timer.localId);
    assert.match(timer.localId, /^[0-9a-f]{8}$/);
    assert.equal(timer.description, "Work on feature");
    assert.equal(timer.state, "active");
    assert.equal(timer.projectId, undefined);
    assert.equal(timer.worktypeId, undefined);
    assert.equal(timer.moduleId, undefined);

    const active = timerStore.listActive();
    assert.equal(active.length, 1);
    assert.equal(active[0].localId, timer.localId);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer accepts the displayed 8-character prefix for legacy UUID timers", () => {
  const { dir, db, timerStore, timeEntryStore, service } = setup();
  try {
    timerStore.insertTimer({
      localId: "92afc830-0000-4000-8000-000000000000",
      description: "Legacy UUID timer",
      startedAt: "2026-04-24T10:00:00.000Z",
      createdAt: "2026-04-24T10:00:00.000Z",
      updatedAt: "2026-04-24T10:00:00.000Z",
    });

    const entry = service.stopTimer({
      localId: "92afc830",
      projectId: 10,
      worktypeId: 5,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(timerStore.getTimer("92afc830-0000-4000-8000-000000000000")?.state, "stopped");
    assert.equal(entry.sourceTimerId, "92afc830-0000-4000-8000-000000000000");
    assert.equal(timeEntryStore.listRecent()[0].localId, entry.localId);
  } finally {
    teardown(dir, db);
  }
});

test("startTimer accepts optional project/worktype/module hints", () => {
  const { dir, db, service } = setup();
  try {
    const timer = service.startTimer({
      description: "Work",
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      now: new Date("2026-04-24T10:00:00Z"),
    });
    assert.equal(timer.projectId, 10);
    assert.equal(timer.worktypeId, 5);
    assert.equal(timer.moduleId, 7);
  } finally {
    teardown(dir, db);
  }
});

test("multiple active timers are allowed", () => {
  const { dir, db, service } = setup();
  try {
    const first = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });
    const second = service.startTimer({ description: "B", now: new Date("2026-04-24T11:00:00Z") });
    const active = service.listActive();
    assert.equal(active.length, 2);
    assert.ok(active.find((t) => t.localId === first.localId));
    assert.ok(active.find((t) => t.localId === second.localId));
  } finally {
    teardown(dir, db);
  }
});

test("editTimer updates active timer project, worktype, and module hints", () => {
  const { dir, db, service, timerStore } = setup();
  try {
    const timer = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });

    const updated = service.editTimer({
      localId: timer.localId,
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      now: new Date("2026-04-24T10:15:00Z"),
    });

    assert.equal(updated.projectId, 10);
    assert.equal(updated.worktypeId, 5);
    assert.equal(updated.moduleId, 7);
    assert.equal(updated.state, "active");
    assert.equal(updated.updatedAt, "2026-04-24T10:15:00.000Z");
    assert.equal(timerStore.getTimer(timer.localId)?.moduleId, 7);
  } finally {
    teardown(dir, db);
  }
});

test("editTimer updates the running timer description", () => {
  const { dir, db, service, timerStore } = setup();
  try {
    const timer = service.startTimer({ description: "Original", now: new Date("2026-04-24T10:00:00Z") });

    const updated = service.editTimer({
      localId: timer.localId,
      description: "Updated timer description",
      now: new Date("2026-04-24T10:15:00Z"),
    });

    assert.equal(updated.description, "Updated timer description");
    assert.equal(updated.updatedAt, "2026-04-24T10:15:00.000Z");
    assert.equal(timerStore.getTimer(timer.localId)?.description, "Updated timer description");
  } finally {
    teardown(dir, db);
  }
});

test("editTimer applies project defaults when project changes", () => {
  const { dir, db, service, defaultsStore } = setup();
  try {
    defaultsStore.setProjectDefaults({ projectId: 20, defaultWorktypeId: 6, defaultModuleId: 8 });
    const timer = service.startTimer({
      description: "A",
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      now: new Date("2026-04-24T10:00:00Z"),
    });

    const updated = service.editTimer({
      localId: timer.localId,
      projectId: 20,
      now: new Date("2026-04-24T10:15:00Z"),
    });

    assert.equal(updated.projectId, 20);
    assert.equal(updated.worktypeId, 6);
    assert.equal(updated.moduleId, 8);
  } finally {
    teardown(dir, db);
  }
});

test("deleteTimer removes an active timer without creating a time entry", () => {
  const { dir, db, timerStore, timeEntryStore, service } = setup();
  try {
    const timer = service.startTimer({ description: "Discard me", now: new Date("2026-04-24T10:00:00Z") });

    const deleted = service.deleteTimer({ localId: timer.localId });

    assert.equal(deleted.localId, timer.localId);
    assert.equal(timerStore.getTimer(timer.localId), undefined);
    assert.equal(timeEntryStore.listRecent().length, 0);
  } finally {
    teardown(dir, db);
  }
});

test("deleteTimer removes a stopped timer when no time entry links to it", () => {
  const { dir, db, timerStore, service } = setup();
  try {
    const timer = timerStore.insertTimer({
      localId: "orphan01",
      description: "Orphan stopped timer",
      startedAt: "2026-04-24T10:00:00.000Z",
      createdAt: "2026-04-24T10:00:00.000Z",
      updatedAt: "2026-04-24T10:00:00.000Z",
    });
    timerStore.markTimerStopped(timer.localId, "2026-04-24T10:30:00.000Z", 1800);

    const deleted = service.deleteTimer({ localId: timer.localId });

    assert.equal(deleted.localId, timer.localId);
    assert.equal(timerStore.getTimer(timer.localId), undefined);
  } finally {
    teardown(dir, db);
  }
});

test("deleteTimer refuses a stopped timer with a linked time entry", () => {
  const { dir, db, timerStore, timeEntryStore, service } = setup();
  try {
    const timer = service.startTimer({ description: "Linked timer", now: new Date("2026-04-24T10:00:00Z") });
    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 10,
      worktypeId: 5,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.throws(() => service.deleteTimer({ localId: timer.localId }), /linked time entry/);
    assert.equal(timerStore.getTimer(timer.localId)?.state, "stopped");
    assert.equal(timeEntryStore.getTimeEntry(entry.localId)?.sourceTimerId, timer.localId);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer by localId creates pending time entry and stops timer", () => {
  const { dir, db, timerStore, timeEntryStore, service } = setup();
  try {
    const first = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });
    const second = service.startTimer({ description: "B", now: new Date("2026-04-24T11:00:00Z") });

    const entry = service.stopTimer({
      localId: first.localId,
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(timerStore.listActive().length, 1);
    assert.equal(timerStore.listActive()[0].localId, second.localId);

    const timer = timerStore.getTimer(first.localId);
    assert.equal(timer?.state, "stopped");
    assert.equal(timer?.elapsedSeconds, 1800);
    assert.equal(timer?.stoppedAt, "2026-04-24T10:30:00.000Z");

    assert.equal(entry.projectId, 10);
    assert.equal(entry.worktypeId, 5);
    assert.equal(entry.moduleId, 7);
    assert.equal(entry.durationSeconds, 1800);
    assert.equal(entry.date, "2026-04-24");
    assert.equal(entry.sourceTimerId, first.localId);
    assert.equal(entry.syncStatus, "pending");
    assert.equal(entry.description, "A");
    assert.equal(entry.startAt, first.startedAt);
    assert.equal(entry.endAt, "2026-04-24T10:30:00.000Z");
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer records an overnight timer against its start date", () => {
  const { dir, db, service } = setup();
  try {
    const timer = service.startTimer({ description: "Overnight", now: new Date(2026, 3, 24, 23, 30, 0) });

    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 10,
      worktypeId: 5,
      now: new Date(2026, 3, 25, 15, 0, 0),
    });

    assert.equal(entry.date, "2026-04-24");
    assert.equal(entry.durationSeconds, 55800);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer requires project", () => {
  const { dir, db, service } = setup();
  try {
    const timer = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });
    assert.throws(() => {
      service.stopTimer({ localId: timer.localId, now: new Date("2026-04-24T10:30:00Z") });
    }, /project is required/);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer requires worktype", () => {
  const { dir, db, service } = setup();
  try {
    const timer = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });
    assert.throws(() => {
      service.stopTimer({ localId: timer.localId, projectId: 10, now: new Date("2026-04-24T10:30:00Z") });
    }, /worktype is required/);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer uses project defaults for missing worktype/module", () => {
  const { dir, db, service, defaultsStore } = setup();
  try {
    defaultsStore.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5, defaultModuleId: 7 });

    const timer = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });
    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 10,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(entry.worktypeId, 5);
    assert.equal(entry.moduleId, 7);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer uses timer hints when stop params omitted", () => {
  const { dir, db, service, defaultsStore } = setup();
  try {
    defaultsStore.setProjectDefaults({ projectId: 10, defaultWorktypeId: 99 });

    const timer = service.startTimer({
      description: "A",
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      now: new Date("2026-04-24T10:00:00Z"),
    });
    const entry = service.stopTimer({
      localId: timer.localId,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(entry.projectId, 10);
    assert.equal(entry.worktypeId, 5);
    assert.equal(entry.moduleId, 7);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer allows overriding timer hints at stop time", () => {
  const { dir, db, service } = setup();
  try {
    const timer = service.startTimer({
      description: "A",
      projectId: 10,
      worktypeId: 5,
      moduleId: 7,
      now: new Date("2026-04-24T10:00:00Z"),
    });
    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 20,
      worktypeId: 6,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(entry.projectId, 20);
    assert.equal(entry.worktypeId, 6);
    assert.equal(entry.moduleId, undefined);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer uses default module but explicit worktype when only worktype provided", () => {
  const { dir, db, service, defaultsStore } = setup();
  try {
    defaultsStore.setProjectDefaults({ projectId: 10, defaultWorktypeId: 99, defaultModuleId: 7 });

    const timer = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });
    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 10,
      worktypeId: 5,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(entry.worktypeId, 5);
    assert.equal(entry.moduleId, 7);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer uses project billable setting when billable is omitted", () => {
  const { dir, db, service, catalogStore } = setup();
  try {
    catalogStore.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [{ id: 10, clientId: 1, name: "Internal", active: true, billable: false, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: {} }],
      modules: [],
    });
    const timer = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });

    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 10,
      worktypeId: 5,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(entry.billable, false);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer accepts optional description and billable override", () => {
  const { dir, db, service } = setup();
  try {
    const timer = service.startTimer({ description: "A", now: new Date("2026-04-24T10:00:00Z") });
    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 10,
      worktypeId: 5,
      description: "Updated description",
      billable: false,
      now: new Date("2026-04-24T10:30:00Z"),
    });

    assert.equal(entry.description, "Updated description");
    assert.equal(entry.billable, false);
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer rounds elapsed duration to the nearest 6 minutes", () => {
  const { dir, db, timerStore, service } = setup();
  try {
    const start = new Date("2026-04-24T10:00:00Z");
    const stop = new Date(start.getTime() + 6797 * 1000); // 1h 53m 17s
    const timer = service.startTimer({ description: "Precision", now: start });

    const entry = service.stopTimer({
      localId: timer.localId,
      projectId: 10,
      worktypeId: 5,
      now: stop,
    });

    assert.equal(entry.durationSeconds, 6840, "time entry duration rounds up to 1h 54m");
    assert.equal(entry.durationSeconds % 360, 0, "duration must be on a 6-minute boundary");
    assert.equal(timerStore.getTimer(timer.localId)?.elapsedSeconds, 6797, "timer history preserves actual elapsed seconds");
  } finally {
    teardown(dir, db);
  }
});

test("stopTimer creates a short local time entry id", () => {
  const { dir, db, catalogStore, defaultsStore, service } = setup();
  try {
    catalogStore.replaceCatalog({
      clients: [],
      projects: [{ id: 10, name: "Website", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Dev", active: true, raw: {} }],
      modules: [],
    });
    defaultsStore.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5 });
    const timer = service.startTimer({
      description: "Investigate cost-saving options",
      projectId: 10,
      now: new Date("2026-05-05T07:07:43.897Z"),
    });

    const entry = service.stopTimer({ localId: timer.localId, now: new Date("2026-05-05T08:37:00.000Z") });

    assert.match(entry.localId, /^[0-9a-f]{8}$/);
  } finally {
    teardown(dir, db);
  }
});
