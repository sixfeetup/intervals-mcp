import assert from "node:assert/strict";
import test from "node:test";
import { resolveDateRange } from "../src/domain/date-ranges.js";

test("today resolves to same start and end date", () => {
  assert.deepEqual(resolveDateRange({ range: "today", now: new Date("2026-04-24T12:00:00Z") }), {
    startDate: "2026-04-24",
    endDate: "2026-04-24",
  });
});

test("this_week uses Monday through Sunday", () => {
  assert.deepEqual(resolveDateRange({ range: "this_week", now: new Date("2026-04-24T12:00:00Z") }), {
    startDate: "2026-04-20",
    endDate: "2026-04-26",
  });
});

test("custom requires dates", () => {
  assert.throws(() => resolveDateRange({ range: "custom", now: new Date("2026-04-24T12:00:00Z") }), /start_date and end_date/);
});

test("resolveDateRange supports yesterday", () => {
  assert.deepEqual(
    resolveDateRange({ range: "yesterday" as any, now: new Date("2026-05-05T12:00:00Z") }),
    { startDate: "2026-05-04", endDate: "2026-05-04" },
  );
});
