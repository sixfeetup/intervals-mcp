import assert from "node:assert/strict";
import test from "node:test";
import { calculateDurationForLocalStopTime, formatLocalTimeOfDay, formatTimeEntryWindow } from "../src/domain/time-window.js";

function localIso(year: number, monthIndex: number, day: number, hour: number, minute: number, second = 0, millisecond = 0): string {
  return new Date(year, monthIndex, day, hour, minute, second, millisecond).toISOString();
}

test("formatLocalTimeOfDay renders ISO timestamps as local HH:mm", () => {
  const text = formatLocalTimeOfDay("2026-05-05T07:07:43.897Z", "en-GB");
  assert.match(text, /^\d{2}:\d{2}$/);
});

test("formatLocalTimeOfDay normalizes valid bare H:mm values", () => {
  assert.equal(formatLocalTimeOfDay("7:05", "en-GB"), "07:05");
  assert.equal(formatLocalTimeOfDay("08:35", "en-GB"), "08:35");
});

test("formatLocalTimeOfDay preserves invalid bare-time-shaped values", () => {
  assert.equal(formatLocalTimeOfDay("7:99", "en-GB"), "7:99");
  assert.equal(formatLocalTimeOfDay("25:00", "en-GB"), "25:00");
});

test("formatLocalTimeOfDay preserves invalid non-date strings", () => {
  assert.equal(formatLocalTimeOfDay("not-a-date", "en-GB"), "not-a-date");
});

test("formatTimeEntryWindow renders start and end when both are present", () => {
  const text = formatTimeEntryWindow({ startAt: "07:07", endAt: "08:35" });
  assert.equal(text, "07:07-08:35");
});

test("formatTimeEntryWindow renders empty string when start or end is missing", () => {
  assert.equal(formatTimeEntryWindow({ startAt: "07:07" }), "");
  assert.equal(formatTimeEntryWindow({ endAt: "08:35" }), "");
});

test("calculateDurationForLocalStopTime calculates duration from local HH:mm stop time", () => {
  const startAt = localIso(2026, 4, 5, 7, 7, 43, 897);
  const result = calculateDurationForLocalStopTime({
    date: "2026-05-05",
    startAt,
    stopTime: "08:35",
  });
  const expectedRawDurationSeconds = Math.floor(
    (new Date(2026, 4, 5, 8, 35, 0, 0).getTime() - new Date(startAt).getTime()) / 1000,
  );

  assert.equal(result.endAt, "08:35");
  assert.equal(result.durationSeconds, 5240);
  assert.equal(result.rawDurationSeconds, 5236);
  assert.equal(result.rawDurationSeconds, expectedRawDurationSeconds);
  assert.notEqual(result.rawDurationSeconds, result.durationSeconds);
});

test("calculateDurationForLocalStopTime uses local start date when stored date is UTC date", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const startAt = new Date(2026, 4, 4, 22, 0, 0, 0).toISOString();
    const result = calculateDurationForLocalStopTime({
      date: "2026-05-05",
      startAt,
      stopTime: "22:35",
    });

    assert.equal(result.endAt, "22:35");
    assert.equal(result.rawDurationSeconds, 35 * 60);
    assert.equal(result.durationSeconds, 35 * 60);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test("calculateDurationForLocalStopTime treats stop times before local start as next day", () => {
  const startAt = localIso(2026, 4, 5, 7, 7, 43, 897);
  const result = calculateDurationForLocalStopTime({
    date: "2026-05-05",
    startAt,
    stopTime: "06:35",
  });
  const expectedRawDurationSeconds = Math.floor(
    (new Date(2026, 4, 6, 6, 35, 0, 0).getTime() - new Date(startAt).getTime()) / 1000,
  );

  assert.equal(result.endAt, "06:35");
  assert.equal(result.rawDurationSeconds, expectedRawDurationSeconds);
  assert.equal(result.durationSeconds, Math.round(expectedRawDurationSeconds / 10) * 10);
});

test("calculateDurationForLocalStopTime treats stop times a few seconds before local start as next day", () => {
  const startAt = new Date(2026, 4, 5, 8, 35, 4, 0).toISOString();

  const result = calculateDurationForLocalStopTime({
    date: "2026-05-05",
    startAt,
    stopTime: "08:35",
  });

  assert.equal(result.rawDurationSeconds, 24 * 60 * 60 - 4);
  assert.equal(result.durationSeconds, 24 * 60 * 60);
});

test("calculateDurationForLocalStopTime rejects invalid dates", () => {
  assert.throws(
    () => calculateDurationForLocalStopTime({
      date: "2026-02-31",
      startAt: new Date(2026, 1, 1, 8, 0, 0, 0).toISOString(),
      stopTime: "08:35",
    }),
    /invalid date/,
  );

  assert.throws(
    () => calculateDurationForLocalStopTime({
      date: "2026-13-01",
      startAt: new Date(2026, 11, 1, 8, 0, 0, 0).toISOString(),
      stopTime: "08:35",
    }),
    /invalid date/,
  );
});
