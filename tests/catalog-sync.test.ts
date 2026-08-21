import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncProjectsCatalog } from "../src/domain/catalog-sync.js";
import { CatalogStore } from "../src/domain/catalog-store.js";
import { openDatabase } from "../src/domain/db.js";

test("syncProjectsCatalog fetches all reference resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-sync-"));
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new CatalogStore(db);
    const resources: string[] = [];
    const api = {
      listResource: async (resource: string) => {
        resources.push(resource);
        if (resource === "client") return [{ id: 1, name: "Acme", active: "t" }];
        if (resource === "project") return [{ id: 10, clientid: 1, name: "Website", active: "t", billable: "t" }];
        if (resource === "projectworktype") return [{ id: 100, projectid: 10, worktypeid: 5, worktype: "Development", active: "t" }];
        if (resource === "projectmodule") return [{ id: 200, projectid: 10, moduleid: 7, module: "Backend", active: "t" }];
        return [];
      },
    };
    const result = await syncProjectsCatalog(api, store);
    assert.deepEqual(resources, ["client", "project", "projectworktype", "projectmodule"]);
    assert.equal(result.projects, 1);
    assert.equal(store.searchProjectContext({ query: "website" })[0].modules[0].name, "Backend");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncProjectsCatalog stores project billable status from the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-sync-billable-"));
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new CatalogStore(db);
    const api = {
      listResource: async (resource: string) => {
        if (resource === "client") return [{ id: 1, name: "Acme", active: "t" }];
        if (resource === "project") return [{ id: 10, clientid: 1, name: "Internal", active: "t", billable: "f" }];
        return [];
      },
    };

    await syncProjectsCatalog(api, store);

    assert.equal(store.getProject(10)?.billable, false);
    assert.equal(store.searchProjectContext({ projectId: 10 })[0]?.billable, false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncProjectsCatalog stores active projects and their active classifications only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-intervals-sync-active-"));
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new CatalogStore(db);
    const api = {
      listResource: async (resource: string) => {
        if (resource === "client") {
          return [
            { id: 1, name: "Active Client", active: "t" },
            { id: 2, name: "Inactive Client", active: "f" },
          ];
        }
        if (resource === "project") {
          return [
            { id: 10, clientid: 1, name: "SFUP043 Active", active: "t", billable: "t" },
            { id: 20, clientid: 2, name: "Old Inactive", active: "f", billable: "t" },
          ];
        }
        if (resource === "projectworktype") {
          return [
            { id: 100, projectid: 10, worktypeid: 5, worktype: "Development", active: "t" },
            { id: 101, projectid: 10, worktypeid: 6, worktype: "Inactive Worktype", active: "f" },
            { id: 102, projectid: 20, worktypeid: 7, worktype: "Old Worktype", active: "t" },
          ];
        }
        if (resource === "projectmodule") {
          return [
            { id: 200, projectid: 10, moduleid: 8, module: "Backend", active: "t" },
            { id: 201, projectid: 10, moduleid: 9, module: "Inactive Module", active: "f" },
            { id: 202, projectid: 20, moduleid: 10, module: "Old Module", active: "t" },
          ];
        }
        return [];
      },
    };

    const result = await syncProjectsCatalog(api, store);

    assert.equal(result.projects, 1);
    assert.equal(result.worktypes, 1);
    assert.equal(result.modules, 1);

    assert.equal(store.searchProjectContext({ query: "SFUP043" }).length, 1);
    assert.equal(store.searchProjectContext({ query: "Old Inactive" }).length, 0);

    const activeProject = store.searchProjectContext({ projectId: 10 })[0];
    assert.equal(activeProject.worktypes.length, 1);
    assert.equal(activeProject.worktypes[0].name, "Development");
    assert.equal(activeProject.modules.length, 1);
    assert.equal(activeProject.modules[0].name, "Backend");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
