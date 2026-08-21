import type { Timer } from "./timer-store.js";
import type { TimeEntry } from "./time-entry-store.js";
import type { TimeReport } from "./time-service.js";
import type { SyncPendingResult } from "./sync-service.js";
import { formatEditableLocalId } from "./local-id.js";
import { formatLocalTimeOfDay, formatTimeEntryWindow } from "./time-window.js";

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

type DisplayTimer = Timer & {
  displayElapsedSeconds?: number;
  displayDate?: string;
  displayStartAt?: string;
  displayEndAt?: string;
};

interface TimerRowParts {
  id: string;
  state: Timer["state"];
  status: string;
  window: string;
  duration: string;
  description: string;
}

export function formatTimer(timer: DisplayTimer, now = new Date()): string {
  return formatTimerRows([timer], now)[0] ?? "";
}

export function formatTimerRows(timers: DisplayTimer[], now = new Date()): string[] {
  return formatTimerRowsInternal(timers, now, false);
}

const ANSI_RESET = "\u001b[0m";
const ANSI_BRIGHT_GREEN = "\u001b[92m";
const ANSI_BRIGHT_YELLOW = "\u001b[93m";
const ANSI_BRIGHT_CYAN = "\u001b[96m";
const ANSI_BRIGHT_RED = "\u001b[91m";
const ANSI_DIM = "\u001b[2m";

export function formatBrightTimer(timer: DisplayTimer, now = new Date()): string {
  return formatBrightTimerRows([timer], now)[0] ?? "";
}

export function formatBrightTimerRows(timers: DisplayTimer[], now = new Date()): string[] {
  return formatTimerRowsInternal(timers, now, true);
}

export function formatTimerRowsByDate(timers: DisplayTimer[], now = new Date()): string[] {
  return formatTimerRowsByDateInternal(timers, now, false);
}

export function formatBrightTimerRowsByDate(timers: DisplayTimer[], now = new Date()): string[] {
  return formatTimerRowsByDateInternal(timers, now, true);
}

function formatTimerRowsInternal(timers: DisplayTimer[], now: Date, bright: boolean): string[] {
  const parts = timers.map((timer) => getTimerRowParts(timer, now));
  const statusWidth = Math.max("● stopped".length, ...parts.map((p) => p.status.length));
  const windowWidth = Math.max("00:00-00:00".length, ...parts.map((p) => p.window.length));
  const durationWidth = Math.max(0, ...parts.map((p) => p.duration.length));
  return parts.map((part) => formatTimerRow(part, { statusWidth, windowWidth, durationWidth }, bright));
}

function formatTimerRowsByDateInternal(timers: DisplayTimer[], now: Date, bright: boolean): string[] {
  const parts = timers.map((timer) => ({ timer, part: getTimerRowParts(timer, now) }));
  const statusWidth = Math.max("● stopped".length, ...parts.map((p) => p.part.status.length));
  const windowWidth = Math.max("00:00-00:00".length, ...parts.map((p) => p.part.window.length));
  const durationWidth = Math.max(0, ...parts.map((p) => p.part.duration.length));
  const groups = new Map<string, typeof parts>();

  for (const item of parts) {
    const date = getTimerDate(item.timer);
    groups.set(date, [...(groups.get(date) ?? []), item]);
  }

  const lines: string[] = [];
  for (const [date, group] of groups) {
    if (lines.length > 0) lines.push("");
    const totalSeconds = group.reduce((sum, item) => sum + getTimerElapsedSeconds(item.timer, now), 0);
    lines.push(`${formatTimerDateHeading(date)} · ${formatDuration(totalSeconds)}`);
    lines.push(...group.map((item) => formatTimerRow(item.part, { statusWidth, windowWidth, durationWidth }, bright)));
  }

  return lines;
}

function getTimerRowParts(timer: DisplayTimer, now: Date): TimerRowParts {
  return {
    id: timer.localId.slice(0, 8),
    state: timer.state,
    status: `● ${timer.state}`,
    window: getTimerWindow(timer, now),
    duration: formatDuration(getTimerElapsedSeconds(timer, now)),
    description: timer.description,
  };
}

function formatTimerRow(
  part: TimerRowParts,
  widths: { statusWidth: number; windowWidth: number; durationWidth: number },
  bright: boolean,
): string {
  const statusPadding = " ".repeat(widths.statusWidth - part.status.length);
  const durationPadding = " ".repeat(widths.durationWidth - part.duration.length);
  const statusColor = part.state === "active" ? ANSI_BRIGHT_GREEN : ANSI_DIM;
  const status = bright ? `${statusColor}${part.status}${ANSI_RESET}${statusPadding}` : part.status.padEnd(widths.statusWidth);
  const duration = bright ? `${durationPadding}${ANSI_BRIGHT_YELLOW}${part.duration}${ANSI_RESET}` : part.duration.padStart(widths.durationWidth);
  const id = bright ? `${ANSI_BRIGHT_CYAN}${part.id}${ANSI_RESET}` : part.id;
  return `${status} ${part.window.padEnd(widths.windowWidth)}  ${duration}  ${id}  ${part.description}`;
}

function getTimerWindow(timer: DisplayTimer, now: Date): string {
  const startAt = timer.displayStartAt ?? timer.startedAt;
  const endAt = timer.state === "active"
    ? timer.displayEndAt ?? now.toISOString()
    : timer.displayEndAt ?? timer.stoppedAt;
  if (!startAt || !endAt) return "";
  return `${formatLocalTimeOfDay(startAt)}-${formatLocalTimeOfDay(endAt)}`;
}

function getTimerDate(timer: DisplayTimer): string {
  return timer.displayDate ?? formatLocalDate(timer.startedAt);
}

function formatLocalDate(value: string | undefined): string {
  const date = value ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) return "(unknown date)";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTimerDateHeading(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  const localDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][localDate.getDay()];
  return `${weekday} ${date}`;
}

function getTimerElapsedSeconds(timer: DisplayTimer, now: Date): number {
  if (timer.state === "stopped" && timer.displayElapsedSeconds !== undefined) return timer.displayElapsedSeconds;
  if (timer.state !== "active") return timer.elapsedSeconds;

  const startedAt = new Date(timer.startedAt).getTime();
  if (!Number.isFinite(startedAt)) return timer.elapsedSeconds;

  return Math.max(0, Math.floor((now.getTime() - startedAt) / 1000));
}

export function formatTimeEntry(
  entry: TimeEntry & { projectName?: string; worktypeName?: string; moduleName?: string },
): string {
  const id = formatEditableLocalId(entry.localId);
  const window = formatTimeEntryWindow(entry);
  const windowPart = window ? ` ${window}` : "";
  const dur = formatDuration(entry.durationSeconds);
  const project = entry.projectName ?? `Project ${entry.projectId}`;
  const worktype = entry.worktypeName ?? `Worktype ${entry.worktypeId}`;
  const mod = entry.moduleName ? `/${entry.moduleName}` : "";
  const desc = entry.description ? ` | ${entry.description}` : "";
  let line = `${id} ${entry.date}${windowPart} ${dur} ${project}${mod} (${worktype})${desc}`;
  if (entry.syncStatus === "failed" && entry.lastSyncError) {
    line += ` [failed: ${entry.lastSyncError}]`;
  } else {
    line += ` [${entry.syncStatus}]`;
  }
  return line;
}

export function formatTimeReport(report: TimeReport, options: { label?: string } = {}): string {
  const singleDay = report.startDate === report.endDate;
  const period = singleDay ? report.startDate : `${report.startDate} .. ${report.endDate}`;
  const label = options.label ? `${options.label}  ` : "";
  const lines: string[] = [
    `${ANSI_BRIGHT_CYAN}${label}${period}${ANSI_RESET}  ${ANSI_BRIGHT_YELLOW}Total: ${formatDuration(report.totalSeconds)}${ANSI_RESET} ${ANSI_DIM}· ${report.entries.length} ${pluralize(report.entries.length, "entry", "entries")} · ${report.byProject.length} ${pluralize(report.byProject.length, "project", "projects")}${ANSI_RESET}`,
  ];

  for (const group of [...report.byProject].sort((a, b) => b.totalSeconds - a.totalSeconds)) {
    const entries = report.entries
      .filter((entry) => entry.projectId === group.projectId)
      .sort(compareTimeReportEntries);

    lines.push("");
    lines.push(`${ANSI_BRIGHT_GREEN}● ${group.projectName}${ANSI_RESET}  ${ANSI_BRIGHT_YELLOW}${formatDuration(group.totalSeconds)}${ANSI_RESET}`);

    const classification = formatSharedClassification(entries);
    if (classification) {
      lines.push(`  ${ANSI_DIM}${classification}${ANSI_RESET}`);
    }

    for (const entry of entries) {
      lines.push(formatTimeReportEntryRow(entry, { includeDate: !singleDay }));
    }
  }

  return lines.join("\n");
}

function compareTimeReportEntries(a: TimeReport["entries"][number], b: TimeReport["entries"][number]): number {
  return `${a.date} ${a.startAt ?? ""} ${a.createdAt}`.localeCompare(`${b.date} ${b.startAt ?? ""} ${b.createdAt}`);
}

function formatSharedClassification(entries: TimeReport["entries"]): string {
  const labels = new Set(entries.map((entry) => {
    const parts = [entry.moduleName, entry.worktypeName].filter(Boolean);
    return parts.join(" · ");
  }).filter(Boolean));

  if (labels.size !== 1) return "";
  return [...labels][0];
}

function formatTimeReportEntryRow(entry: TimeReport["entries"][number], options: { includeDate: boolean }): string {
  const id = formatEditableLocalId(entry.localId);
  const date = options.includeDate ? `${entry.date} ` : "";
  const window = formatTimeEntryWindow(entry);
  const windowPart = window ? `${window} ` : "";
  const description = entry.description || "(no description)";
  const failedError = entry.syncStatus === "failed" && entry.lastSyncError ? ` (${entry.lastSyncError})` : "";

  return `  ${ANSI_BRIGHT_CYAN}${id}${ANSI_RESET}  ${ANSI_DIM}${date}${windowPart}${ANSI_RESET}${ANSI_BRIGHT_YELLOW}${formatDuration(entry.durationSeconds)}${ANSI_RESET} ${formatSyncStatusSymbol(entry.syncStatus)} ${description}${failedError}`;
}

function formatSyncStatusSymbol(status: TimeEntry["syncStatus"]): string {
  if (status === "synced") return `${ANSI_BRIGHT_GREEN}✓${ANSI_RESET}`;
  if (status === "pending") return `${ANSI_BRIGHT_YELLOW}●${ANSI_RESET}`;
  if (status === "failed") return `${ANSI_BRIGHT_RED}✕${ANSI_RESET}`;
  return `${ANSI_BRIGHT_YELLOW}!${ANSI_RESET}`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function formatSyncSummary(summary: SyncPendingResult): string {
  return `created=${summary.timeEntriesCreated} updated=${summary.timeEntriesUpdated} failed=${summary.failed}`;
}
