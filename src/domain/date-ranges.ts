import type { TimeRange } from "./types.js";

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

export function resolveDateRange(input: {
  range: TimeRange;
  start_date?: string;
  end_date?: string;
  now?: Date;
}): { startDate: string; endDate: string } {
  const now = input.now ?? new Date();
  const today = utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  if (input.range === "custom") {
    if (!input.start_date || !input.end_date) throw new Error("custom range requires start_date and end_date");
    return { startDate: input.start_date, endDate: input.end_date };
  }

  if (input.range === "today") return { startDate: ymd(today), endDate: ymd(today) };

  if (input.range === "yesterday") {
    const yesterday = utcDate(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1);
    return { startDate: ymd(yesterday), endDate: ymd(yesterday) };
  }

  const day = today.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = utcDate(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + mondayOffset);

  if (input.range === "this_week") {
    return { startDate: ymd(monday), endDate: ymd(utcDate(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6)) };
  }
  if (input.range === "last_week") {
    const start = utcDate(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() - 7);
    const end = utcDate(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() - 1);
    return { startDate: ymd(start), endDate: ymd(end) };
  }
  if (input.range === "this_month") {
    return {
      startDate: ymd(utcDate(today.getUTCFullYear(), today.getUTCMonth(), 1)),
      endDate: ymd(utcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)),
    };
  }
  if (input.range === "last_month") {
    return {
      startDate: ymd(utcDate(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
      endDate: ymd(utcDate(today.getUTCFullYear(), today.getUTCMonth(), 0)),
    };
  }
  throw new Error(`Unsupported range: ${input.range}`);
}
