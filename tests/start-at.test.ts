import assert from "node:assert/strict";
import test from "node:test";
import { parseTimerStartAt } from "../src/domain/start-at.js";

function assertLocalDateTime(date: Date, expected: { year: number; month: number; day: number; hour: number; minute: number }) {
  assert.equal(date.getFullYear(), expected.year);
  assert.equal(date.getMonth() + 1, expected.month);
  assert.equal(date.getDate(), expected.day);
  assert.equal(date.getHours(), expected.hour);
  assert.equal(date.getMinutes(), expected.minute);
  assert.equal(date.getSeconds(), 0);
  assert.equal(date.getMilliseconds(), 0);
}

test("parseTimerStartAt parses HH:mm as today in local time", () => {
  const reference = new Date(2026, 4, 13, 10, 0, 0, 0);
  const parsed = parseTimerStartAt("9:30", reference);

  assertLocalDateTime(parsed, { year: 2026, month: 5, day: 13, hour: 9, minute: 30 });
});

test("parseTimerStartAt parses zero-padded HH:mm as today in local time", () => {
  const reference = new Date(2026, 4, 13, 10, 0, 0, 0);
  const parsed = parseTimerStartAt("09:30", reference);

  assertLocalDateTime(parsed, { year: 2026, month: 5, day: 13, hour: 9, minute: 30 });
});

test("parseTimerStartAt parses YYYY-MM-DD HH:mm as local date and time", () => {
  const reference = new Date(2026, 4, 13, 10, 0, 0, 0);
  const parsed = parseTimerStartAt("2026-05-12 16:45", reference);

  assertLocalDateTime(parsed, { year: 2026, month: 5, day: 12, hour: 16, minute: 45 });
});

test("parseTimerStartAt parses ISO datetimes exactly", () => {
  const reference = new Date("2026-05-13T10:00:00.000Z");
  const parsed = parseTimerStartAt("2026-05-13T09:30:00.000Z", reference);

  assert.equal(parsed.toISOString(), "2026-05-13T09:30:00.000Z");
});

test("parseTimerStartAt rejects invalid values", () => {
  const reference = new Date(2026, 4, 13, 10, 0, 0, 0);

  assert.throws(() => parseTimerStartAt("", reference), /invalid start_at:/);
  assert.throws(() => parseTimerStartAt("not a time", reference), /invalid start_at: not a time/);
  assert.throws(() => parseTimerStartAt("25:00", reference), /invalid start_at: 25:00/);
  assert.throws(() => parseTimerStartAt("2026-05-13 09:99", reference), /invalid start_at: 2026-05-13 09:99/);
});

test("parseTimerStartAt rejects unsupported JavaScript date strings", () => {
  const reference = new Date(2026, 4, 13, 10, 0, 0, 0);

  assert.throws(() => parseTimerStartAt("05/13/2026 09:30", reference), /invalid start_at: 05\/13\/2026 09:30/);
  assert.throws(() => parseTimerStartAt("May 13 2026 09:30", reference), /invalid start_at: May 13 2026 09:30/);
});

test("parseTimerStartAt rejects start times in the future", () => {
  const reference = new Date(2026, 4, 13, 10, 0, 0, 0);

  assert.throws(() => parseTimerStartAt("10:01", reference), /start_at cannot be in the future: 10:01/);
});
