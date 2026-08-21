import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/domain/db.js";
import { CatalogStore } from "../src/domain/catalog-store.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "pi-intervals-catalog-"));
}

function setup() {
  const dir = tmpDir();
  const db = openDatabase(join(dir, "intervals.db"));
  const store = new CatalogStore(db);
  return { dir, db, store };
}

function teardown(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("catalog store upserts and searches project context", () => {
  const dir = tmpDir();
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new CatalogStore(db);
    store.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: { id: 1, name: "Acme" } }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: { id: 10 } }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: { id: 100 } }],
      modules: [{ id: 200, projectId: 10, moduleId: 7, name: "Backend", active: true, raw: { id: 200 } }],
    });

    const matches = store.searchProjectContext({ query: "acme website" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].projectName, "Website");
    assert.equal(matches[0].clientName, "Acme");
    assert.equal(matches[0].worktypes[0].name, "Development");
    assert.equal(matches[0].modules[0].name, "Backend");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getProject, getWorktype, getModule", () => {
  const dir = tmpDir();
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new CatalogStore(db);
    store.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: { id: 1 } }],
      projects: [{ id: 10, clientId: 1, name: "Website", active: true, billable: true, raw: { id: 10 } }],
      worktypes: [{ id: 100, projectId: 10, worktypeId: 5, name: "Development", active: true, raw: { id: 100 } }],
      modules: [{ id: 200, projectId: 10, moduleId: 7, name: "Backend", active: true, raw: { id: 200 } }],
    });

    const p = store.getProject(10);
    assert.equal(p?.name, "Website");

    const w = store.getWorktype(10, 5);
    assert.equal(w?.name, "Development");

    const m = store.getModule(10, 7);
    assert.equal(m?.name, "Backend");

    assert.equal(store.getProject(999), undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("last project sync settings", () => {
  const dir = tmpDir();
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new CatalogStore(db);
    assert.equal(store.getLastProjectSync(), undefined);
    store.setLastProjectSync("2026-04-24T12:00:00Z");
    assert.equal(store.getLastProjectSync(), "2026-04-24T12:00:00Z");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceCatalog overwrites previous data", () => {
  const dir = tmpDir();
  try {
    const db = openDatabase(join(dir, "intervals.db"));
    const store = new CatalogStore(db);
    store.replaceCatalog({
      clients: [{ id: 1, name: "Old", active: true, raw: { id: 1 } }],
      projects: [{ id: 10, clientId: 1, name: "Old", active: true, billable: true, raw: { id: 10 } }],
      worktypes: [],
      modules: [],
    });

    store.replaceCatalog({
      clients: [{ id: 2, name: "New", active: true, raw: { id: 2 } }],
      projects: [{ id: 20, clientId: 2, name: "New", active: true, billable: false, raw: { id: 20 } }],
      worktypes: [],
      modules: [],
    });

    assert.equal(store.getProject(10), undefined);
    assert.equal(store.getProject(20)?.name, "New");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchProjectContext matches sysadmin alias to System Administration", () => {
  const { dir, db, store } = setup();
  try {
    store.replaceCatalog({
      clients: [{ id: 1, name: "Six Feet Up", active: true, raw: {} }],
      projects: [
        { id: 67184, clientId: 1, name: "SFUP001 - System Administration", active: true, billable: true, raw: {} },
        { id: 67200, clientId: 1, name: "SFUP008 - Business Development", active: true, billable: true, raw: {} },
      ],
      worktypes: [
        { id: 1, projectId: 67184, worktypeId: 124393, name: "Hosting", active: true, raw: {} },
      ],
      modules: [
        { id: 2, projectId: 67184, moduleId: 183570, name: "Internal Services - Six Feet Up", active: true, raw: {} },
      ],
    });

    const results = store.searchProjectContext({ query: "six feet up sysadmin", limit: 5 });

    assert.equal(results[0].projectId, 67184);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("searchProjectContext does not drop later ranked matches outside the initial candidate window", () => {
  const { dir, db, store } = setup();
  try {
    const projects = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      clientId: 1,
      name: `AAA${String(index + 1).padStart(3, "0")} - Backlog ${index + 1}`,
      active: true,
      billable: true,
      raw: {},
    }));

    projects.push({
      id: 500,
      clientId: 1,
      name: "ZZZ999 - System Administration",
      active: true,
      billable: true,
      raw: {},
    });

    store.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects,
      worktypes: [],
      modules: [],
    });

    const results = store.searchProjectContext({ query: "zzz999", limit: 5 });

    assert.equal(results[0]?.projectId, 500);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("searchProjectContext ranks exact project code token matches ahead of substring matches", () => {
  const { dir, db, store } = setup();
  try {
    store.replaceCatalog({
      clients: [{ id: 1, name: "Acme", active: true, raw: {} }],
      projects: [
        { id: 10, clientId: 1, name: "AAA - ABC1234 Expansion", active: true, billable: true, raw: {} },
        { id: 20, clientId: 1, name: "ZZZ - ABC123 Platform", active: true, billable: true, raw: {} },
      ],
      worktypes: [],
      modules: [],
    });

    const results = store.searchProjectContext({ query: "ABC123", limit: 5 });

    assert.equal(results[0]?.projectId, 20);
  } finally {
    db.close();
    teardown(dir);
  }
});

test("searchProjectContext matches worktype and module names", () => {
  const { dir, db, store } = setup();
  try {
    store.replaceCatalog({
      clients: [{ id: 1, name: "Six Feet Up", active: true, raw: {} }],
      projects: [{ id: 67184, clientId: 1, name: "SFUP001 - System Administration", active: true, billable: true, raw: {} }],
      worktypes: [{ id: 1, projectId: 67184, worktypeId: 124393, name: "Hosting", active: true, raw: {} }],
      modules: [{ id: 2, projectId: 67184, moduleId: 183570, name: "Internal Services - Six Feet Up", active: true, raw: {} }],
    });

    assert.equal(store.searchProjectContext({ query: "hosting", limit: 5 })[0].projectId, 67184);
    assert.equal(store.searchProjectContext({ query: "internal services", limit: 5 })[0].projectId, 67184);
  } finally {
    db.close();
    teardown(dir);
  }
});
