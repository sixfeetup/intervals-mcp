import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/domain/db.js";

test("openDatabase creates required tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-db-"));
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const rows = db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const expected of ["clients", "projects", "project_worktypes", "project_modules", "project_defaults", "timers", "time_entries", "settings"]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timers schema: nullable project/worktype/module, required description, no sync columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-db-"));
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const cols = db.prepare("pragma table_info(timers)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    // Nullable per schema amendments
    assert.equal(colMap.get("project_id")?.notnull, 0, "project_id should be nullable");
    assert.equal(colMap.get("worktype_id")?.notnull, 0, "worktype_id should be nullable");
    assert.equal(colMap.get("module_id")?.notnull, 0, "module_id should be nullable");

    // Required description
    assert.equal(colMap.get("description")?.notnull, 1, "description should be not null");

    // No sync columns on timers (local-only in v1)
    assert.ok(!colMap.has("remote_id"), "timers should not have remote_id");
    assert.ok(!colMap.has("sync_status"), "timers should not have sync_status");
    assert.ok(!colMap.has("sync_attempts"), "timers should not have sync_attempts");
    assert.ok(!colMap.has("last_sync_error"), "timers should not have last_sync_error");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("time_entries schema: retains sync metadata and source_timer_id", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-db-"));
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const cols = db.prepare("pragma table_info(time_entries)").all() as Array<{ name: string; notnull: number }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    assert.ok(colMap.has("remote_id"), "time_entries should have remote_id");
    assert.ok(colMap.has("sync_status"), "time_entries should have sync_status");
    assert.ok(colMap.has("sync_attempts"), "time_entries should have sync_attempts");
    assert.ok(colMap.has("last_sync_error"), "time_entries should have last_sync_error");
    assert.ok(colMap.has("source_timer_id"), "time_entries should have source_timer_id");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase sets busy_timeout to 5000", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervals-db-pragma-"));
  try {
    const db = openDatabase(join(dir, "t.db"));
    const row = db.prepare("PRAGMA busy_timeout").get<{ timeout: number }>();
    assert.equal(row?.timeout, 5000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
