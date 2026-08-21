import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/domain/db.js";
import { claimSyncLease, releaseSyncLease, withSyncLease, SYNC_LEASE_TTL_MS } from "../src/domain/sync-lease.js";

function tempDbPath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "intervals-lease-"));
  return { path: join(dir, "intervals.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const T0 = 1_000_000;

test("two claimants: second claim fails while the first holds", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    assert.equal(claimSyncLease(db, "owner-b", T0), false);
    db.close();
  } finally {
    cleanup();
  }
});

test("renewal: the holder can re-claim its own unexpired lease, extending the expiry", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    assert.equal(claimSyncLease(db, "owner-a", T0 + 30_000), true);
    assert.equal(claimSyncLease(db, "owner-b", T0 + 30_000), false);
    // The renewal at T0+30s moved the expiry to T0+90s — the original T0+60s is dead.
    assert.equal(claimSyncLease(db, "owner-b", T0 + 70_000), false);
    assert.equal(claimSyncLease(db, "owner-b", T0 + 90_001), true);
    db.close();
  } finally {
    cleanup();
  }
});

test("expiry takeover: a crashed holder's lease is claimable after the TTL", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    assert.equal(claimSyncLease(db, "owner-b", T0 + SYNC_LEASE_TTL_MS - 1), false);
    assert.equal(claimSyncLease(db, "owner-b", T0 + SYNC_LEASE_TTL_MS + 1), true);
    db.close();
  } finally {
    cleanup();
  }
});

test("release: another owner can claim immediately after release", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    releaseSyncLease(db, "owner-a");
    assert.equal(claimSyncLease(db, "owner-b", T0), true);
    db.close();
  } finally {
    cleanup();
  }
});

test("release is owner-guarded: a non-holder's release does nothing", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    releaseSyncLease(db, "owner-b");
    assert.equal(claimSyncLease(db, "owner-b", T0), false);
    db.close();
  } finally {
    cleanup();
  }
});

test("withSyncLease: runs the function, releases afterward, and skips a concurrent claimant", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const dbA = openDatabase(path);
    const dbB = openDatabase(path);
    let running = 0;
    let overlapped = false;
    const work = async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
      running -= 1;
      return "ran";
    };
    const [a, b] = await Promise.all([
      withSyncLease(dbA, "owner-a", work),
      withSyncLease(dbB, "owner-b", work),
    ]);
    assert.equal(overlapped, false, "sync passes never overlap");
    assert.equal([a, b].filter((r) => r === "ran").length, 1, "exactly one claimant ran");
    assert.equal([a, b].filter((r) => r === undefined).length, 1, "the other skipped");
    // released afterward: a fresh owner claims immediately
    assert.equal(claimSyncLease(dbA, "owner-c", T0), true);
    dbA.close();
    dbB.close();
  } finally {
    cleanup();
  }
});

test("withSyncLease releases the lease when fn throws", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    await assert.rejects(withSyncLease(db, "owner-a", async () => {
      throw new Error("boom");
    }), /boom/);
    assert.equal(claimSyncLease(db, "owner-b", T0), true);
    db.close();
  } finally {
    cleanup();
  }
});
