import assert from "node:assert/strict";
import test from "node:test";
import { startBackgroundSync } from "../src/domain/background-sync.js";

test("startBackgroundSync calls syncNow on tick", async () => {
  let calls = 0;
  const syncNow = async () => {
    calls++;
  };
  const handle = startBackgroundSync({ intervalMs: 10000, syncNow });
  await handle.tick();
  assert.equal(calls, 1);
  handle.stop();
});

test("startBackgroundSync avoids overlapping runs", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const syncNow = async () => {
    concurrent++;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    await new Promise((r) => setTimeout(r, 20));
    concurrent--;
  };
  const handle = startBackgroundSync({ intervalMs: 10000, syncNow });
  // Fire two ticks in quick succession
  const p1 = handle.tick();
  const p2 = handle.tick();
  await Promise.all([p1, p2]);
  assert.equal(maxConcurrent, 1, "should never have overlapping sync runs");
  handle.stop();
});

test("startBackgroundSync calls onError when syncNow throws", async () => {
  const error = new Error("boom");
  const syncNow = async () => {
    throw error;
  };
  let captured: unknown;
  const handle = startBackgroundSync({
    intervalMs: 10000,
    syncNow,
    onError: (e) => {
      captured = e;
    },
  });
  await handle.tick();
  assert.equal(captured, error);
  handle.stop();
});

test("startBackgroundSync interval fires repeatedly", async () => {
  let calls = 0;
  const syncNow = async () => {
    calls++;
  };
  const handle = startBackgroundSync({ intervalMs: 15, syncNow });
  await new Promise((r) => setTimeout(r, 60));
  handle.stop();
  assert.ok(calls >= 2, `expected at least 2 calls, got ${calls}`);
});

test("stop prevents further interval ticks", async () => {
  let calls = 0;
  const syncNow = async () => {
    calls++;
  };
  const handle = startBackgroundSync({ intervalMs: 15, syncNow });
  await new Promise((r) => setTimeout(r, 30));
  handle.stop();
  const afterStop = calls;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, afterStop, "should not tick after stop");
});
