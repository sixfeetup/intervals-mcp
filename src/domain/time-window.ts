export function formatLocalTimeOfDay(value: string | undefined, locale = undefined as string | undefined): string {
  if (!value) return "";

  const bareTimeMatch = value.match(/^(\d{1,2}):(\d{2})$/);
  if (bareTimeMatch) {
    const hour = Number(bareTimeMatch[1]);
    const minute = Number(bareTimeMatch[2]);
    if (hour <= 23 && minute <= 59) return `${String(hour).padStart(2, "0")}:${bareTimeMatch[2]}`;
    return value;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatTimeEntryWindow(input: { startAt?: string; endAt?: string }, locale?: string): string {
  if (!input.startAt || !input.endAt) return "";
  return `${formatLocalTimeOfDay(input.startAt, locale)}-${formatLocalTimeOfDay(input.endAt, locale)}`;
}

function parseStrictLocalDate(value: string): { year: number; month: number; day: number } {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`invalid date: ${value}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    throw new Error(`invalid date: ${value}`);
  }

  return { year, month, day };
}

function parseStrictLocalTime(value: string, label: string): { hour: number; minute: number } {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${label} must be HH:mm local time`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`${label} must be HH:mm local time`);
  }

  return { hour, minute };
}

function parseLocalStartAt(date: string, startAt: string): Date {
  const bareTimeMatch = startAt.match(/^(\d{1,2}):(\d{2})$/);
  if (bareTimeMatch) {
    const { year, month, day } = parseStrictLocalDate(date);
    const { hour, minute } = parseStrictLocalTime(startAt, "start_at");
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  const parsed = new Date(startAt);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid start_at: ${startAt}`);
  return parsed;
}

export function calculateDurationForLocalStopTime(input: {
  date: string;
  startAt?: string;
  stopTime: string;
}): { endAt: string; durationSeconds: number; rawDurationSeconds: number } {
  if (!input.startAt) throw new Error("start_at is required to calculate duration from stop_time");

  const start = parseLocalStartAt(input.date, input.startAt);
  const { hour, minute } = parseStrictLocalTime(input.stopTime, "stop_time");

  parseStrictLocalDate(input.date);
  const stop = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour, minute, 0, 0);
  if (stop.getTime() < start.getTime()) stop.setDate(stop.getDate() + 1);
  const rawDurationSeconds = Math.floor((stop.getTime() - start.getTime()) / 1000);

  return {
    endAt: input.stopTime.padStart(5, "0"),
    durationSeconds: Math.round(rawDurationSeconds / 10) * 10,
    rawDurationSeconds,
  };
}
