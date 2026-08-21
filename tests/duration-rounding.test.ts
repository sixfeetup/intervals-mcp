import assert from "node:assert/strict";
import test from "node:test";
import { ROUNDING_SECONDS, roundDurationSecondsForIntervals } from "../src/domain/duration-rounding.js";

test("ROUNDING_SECONDS is 6 minutes", () => {
  assert.equal(ROUNDING_SECONDS, 360);
});

test("roundDurationSecondsForIntervals snaps arbitrary seconds to nearest 6 minutes", () => {
  assert.equal(roundDurationSecondsForIntervals(6797), 6840, "6797s rounds up to 6840s (1h 54m)");
  assert.equal(roundDurationSecondsForIntervals(6780), 6840, "6780s (113m) rounds up to 114m");
  assert.equal(roundDurationSecondsForIntervals(6480), 6480, "6480s (108m) is already on a 6m boundary");
  assert.equal(roundDurationSecondsForIntervals(300), 360, "5m rounds up to 6m");
  assert.equal(roundDurationSecondsForIntervals(60), 0, "1m rounds down to 0m");
});

test("roundDurationSecondsForIntervals breaks ties upward", () => {
  assert.equal(roundDurationSecondsForIntervals(180), 360, "3m (exact half) rounds up to 6m");
});

test("roundDurationSecondsForIntervals handles zero and negative durations", () => {
  assert.equal(roundDurationSecondsForIntervals(0), 0);
  assert.equal(roundDurationSecondsForIntervals(-100), 0);
});

test("roundDurationSecondsForIntervals always produces a multiple of ROUNDING_SECONDS", () => {
  for (const seconds of [1, 59, 60, 359, 360, 361, 1799, 1800, 1801, 6779, 6797, 9999]) {
    const rounded = roundDurationSecondsForIntervals(seconds);
    assert.equal(rounded % ROUNDING_SECONDS, 0, `${seconds}s rounded to ${rounded}s`);
  }
});
