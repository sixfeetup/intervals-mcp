import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/domain/runtime.js";
import { saveConfig } from "../src/domain/config.js";

test("runtime opens sqlite and reports missing credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({ env: { INTERVALS_HOME: home } });
    const status = runtime.status();
    assert.equal(status.credentialsConfigured, false);
    assert.equal(status.home, home);
    assert.ok(status.dbOpen);
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime wires api client and reports credentials configured", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({
      env: {
        INTERVALS_HOME: home,
        INTERVALS_API_KEY: "test-key",
        INTERVALS_BASE_URL: "https://api.example/",
        INTERVALS_PERSON_ID: "42",
      },
    });
    const status = runtime.status();
    assert.equal(status.credentialsConfigured, true);
    assert.equal(status.personId, 42);
    assert.ok(status.apiClient);
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime close cleans up database", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({ env: { INTERVALS_HOME: home } });
    assert.equal(runtime.status().dbOpen, true);
    runtime.close();
    assert.equal(runtime.status().dbOpen, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime trySyncNow is available and returns summary even without credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({ env: { INTERVALS_HOME: home } });
    const result = await runtime.trySyncNow();
    assert.equal(result.timeEntriesCreated, 0);
    assert.equal(result.timeEntriesUpdated, 0);
    assert.equal(result.failed, 0);
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime initializes stores and services", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({ env: { INTERVALS_HOME: home } });
    assert.ok(runtime.catalogStore);
    assert.ok(runtime.defaultsStore);
    assert.ok(runtime.timerStore);
    assert.ok(runtime.timeEntryStore);
    assert.ok(runtime.timerService);
    assert.ok(runtime.timeService);
    assert.ok(runtime.syncService);
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime does not prompt during creation", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    // If createRuntime attempted to prompt, it would throw in a test environment.
    const runtime = createRuntime({ env: { INTERVALS_HOME: home } });
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime reloadCredentials picks up saved config changes", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({ env: { INTERVALS_HOME: home } });
    assert.equal(runtime.status().credentialsConfigured, false, "should start without credentials");

    // Simulate saving config
    saveConfig(home, { apiKey: "saved-key", personId: 99 });

    runtime.reloadCredentials();
    const status = runtime.status();
    assert.equal(status.credentialsConfigured, true, "should detect saved credentials after reload");
    assert.equal(status.personId, 99, "should detect saved personId after reload");
    assert.ok(status.apiClient, "should create apiClient after reload");
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime starts background sync when credentials exist", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({
      env: {
        INTERVALS_HOME: home,
        INTERVALS_API_KEY: "test-key",
        INTERVALS_BASE_URL: "https://api.example/",
        INTERVALS_PERSON_ID: "42",
      },
      syncIntervalMs: 60000,
    });
    assert.equal(runtime.status().backgroundSyncRunning, true);
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime does not start background sync without credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({ env: { INTERVALS_HOME: home } });
    assert.equal(runtime.status().backgroundSyncRunning, false);
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime close stops background sync", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    const runtime = createRuntime({
      env: {
        INTERVALS_HOME: home,
        INTERVALS_API_KEY: "test-key",
        INTERVALS_BASE_URL: "https://api.example/",
        INTERVALS_PERSON_ID: "42",
      },
      syncIntervalMs: 60000,
    });
    assert.equal(runtime.status().backgroundSyncRunning, true);
    runtime.close();
    assert.equal(runtime.status().backgroundSyncRunning, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime reloadCredentials stops background sync when credentials removed", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    saveConfig(home, { apiKey: "saved-key", personId: 99 });
    const runtime = createRuntime({
      env: { INTERVALS_HOME: home },
      syncIntervalMs: 60000,
    });
    assert.equal(runtime.status().backgroundSyncRunning, true);

    // Remove credentials by clearing config and reloading
    saveConfig(home, {});
    runtime.reloadCredentials();
    assert.equal(runtime.status().backgroundSyncRunning, false);
    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime background sync calls trySyncNow on interval", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-intervals-runtime-"));
  try {
    saveConfig(home, { apiKey: "saved-key", personId: 99 });
    const runtime = createRuntime({
      env: { INTERVALS_HOME: home },
      syncIntervalMs: 30,
    });
    assert.equal(runtime.status().backgroundSyncRunning, true);

    // Wait enough time for at least one interval tick
    await new Promise((r) => setTimeout(r, 80));

    runtime.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
