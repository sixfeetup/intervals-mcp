import { formatDuration } from "./format.js";
import type { TimeEntry } from "./time-entry-store.js";
import { calculateDurationForLocalStopTime, formatLocalTimeOfDay } from "./time-window.js";

export interface StopTimeEditSummary {
  start: string;
  end: string;
  rawDurationSeconds: number;
  roundedDurationSeconds: number;
}

export function buildStopTimeEditSummary(input: {
  existingEntry: Pick<TimeEntry, "date" | "startAt">;
  date?: string;
  startAt?: string | null;
  stopTime: string;
  roundedDurationSeconds: number;
}): StopTimeEditSummary {
  const startAt = input.startAt === undefined ? input.existingEntry.startAt : input.startAt ?? undefined;
  const result = calculateDurationForLocalStopTime({
    date: input.date ?? input.existingEntry.date,
    startAt,
    stopTime: input.stopTime,
  });

  return {
    start: formatLocalTimeOfDay(startAt),
    end: formatLocalTimeOfDay(result.endAt),
    rawDurationSeconds: result.rawDurationSeconds,
    roundedDurationSeconds: input.roundedDurationSeconds,
  };
}

export function formatStopTimeEditSummary(summary: StopTimeEditSummary): string {
  return [
    `start: ${summary.start}`,
    `end: ${summary.end}`,
    `raw duration: ${formatDuration(summary.rawDurationSeconds)}`,
    `rounded duration: ${formatDuration(summary.roundedDurationSeconds)}`,
  ].join("\n");
}
