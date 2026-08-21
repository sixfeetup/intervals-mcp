import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/domain/db.js";
import { ProjectDefaultsStore } from "../src/domain/project-defaults-store.js";

test("project defaults fill missing worktype and module", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-defaults-"));
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new ProjectDefaultsStore(db);
    store.setProjectDefaults({ projectId: 10, defaultWorktypeId: 5, defaultModuleId: 7 });
    assert.deepEqual(store.resolveForProject({ projectId: 10 }), { worktypeId: 5, moduleId: 7 });
    assert.deepEqual(store.resolveForProject({ projectId: 10, worktypeId: 6 }), { worktypeId: 6, moduleId: 7 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
