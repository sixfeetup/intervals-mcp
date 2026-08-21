import type { DisplayTimer } from "./format.js";
import type { TimeEntryStore } from "./time-entry-store.js";
import type { Timer } from "./timer-store.js";

export function withLinkedTimeEntryDuration(timeEntryStore: TimeEntryStore, timer: Timer): DisplayTimer {
  if (timer.state !== "stopped") return timer;
  const entry = timeEntryStore.findBySourceTimerId(timer.localId);
  return entry
    ? {
        ...timer,
        displayElapsedSeconds: entry.durationSeconds,
        displayDate: entry.date,
        displayStartAt: entry.startAt,
        displayEndAt: entry.endAt,
      }
    : timer;
}
