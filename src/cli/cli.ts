import { loadConfig, saveConfig } from "../domain/config.js";
import {
  formatSyncSummary,
  formatTimeEntry,
  formatTimer,
  formatTimeReport,
  formatTimerRows,
  formatTimerRowsByDate,
} from "../domain/format.js";
import { formatEditableLocalId } from "../domain/local-id.js";
import type { Runtime } from "../domain/runtime.js";
import { buildStopTimeEditSummary, formatStopTimeEditSummary } from "../domain/time-edit-feedback.js";
import { withLinkedTimeEntryDuration } from "../domain/timer-display.js";
import type { TimeRange } from "../domain/types.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  prompt(question: string): Promise<string>;
  promptSecret(question: string): Promise<string>;
  interactive: boolean;
  bright: boolean;
}

export const USAGE = [
  "Usage: intervals <command> [args]",
  "",
  "Commands:",
  "  setup                                     Configure credentials and run initial project sync",
  "  status                                    Show DB path, credential source, timers, pending sync",
  "  sync-projects                             Refresh the local project catalog",
  "  sync-now                                  Push pending time entries to Intervals now",
  "  timers [recent]                           Show active (or recent) timers",
  "  timers edit <timer_id> [field=value ...]  Edit a timer (project_id, worktype_id, module_id|null, description)",
  "  timers delete <timer_id>                  Delete a timer with no linked time entry",
  "  time [range]                              Report time entries (today, yesterday, this-week, last-week,",
  "                                            this-month, last-month, YYYY-MM-DD, YYYY-MM-DD..YYYY-MM-DD)",
  "  time edit <id> [field=value ...]          Edit a time entry (stop_time=HH:mm recalculates duration)",
  "  project-defaults <project_id> <worktype_id> [module_id]   Set project defaults",
].join("\n");

export async function runCli(argv: string[], runtime: Runtime, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return await setup(runtime, io);
      case "status":
        return status(runtime, io);
      case "sync-projects":
        return await syncProjects(runtime, io);
      case "sync-now":
        return await syncNow(runtime, io);
      case "timers":
        return await timers(runtime, io, rest);
      case "time":
        return await time(runtime, io, rest);
      case "project-defaults":
        return projectDefaults(runtime, io, rest);
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case undefined:
        io.err(USAGE);
        return 2;
      default:
        io.err(`Unknown command: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runCatalogSync(runtime: Runtime, io: CliIo): Promise<number> {
  try {
    const result = await runtime.syncProjectsCatalog();
    io.out(
      `Project sync complete: ${result.projects} projects, ${result.worktypes} worktypes, ${result.modules} modules, ${result.clients} clients`,
    );
    return 0;
  } catch (error) {
    io.err(`Project sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function setup(runtime: Runtime, io: CliIo): Promise<number> {
  const current = runtime.status();
  const home = current.home;

  if (current.credentialSource === "env" || current.credentialSource === "config") {
    const source = current.credentialSource === "env" ? "environment" : "config file";
    io.out(`Intervals credentials loaded from ${source}. Database: ${home}`);
    return runCatalogSync(runtime, io);
  }

  if (!io.interactive) {
    io.err("Intervals credentials are not configured. Set INTERVALS_API_KEY or run `intervals setup` in an interactive terminal.");
    return 1;
  }

  const apiKey = await io.promptSecret("Intervals API key:");
  if (!apiKey) {
    io.err("Setup cancelled: API key is required.");
    return 1;
  }

  const personIdInput = await io.prompt("Intervals person ID (optional):");
  const personId = personIdInput ? Number(personIdInput) : undefined;
  if (personIdInput && !Number.isFinite(personId)) {
    io.err("Setup cancelled: person ID must be a valid number.");
    return 1;
  }

  const config = loadConfig(home);
  saveConfig(home, { ...config, apiKey, personId: personId ?? config.personId });
  io.out(`Credentials saved to ${home}/config.json`);
  runtime.reloadCredentials();
  return runCatalogSync(runtime, io);
}

function status(runtime: Runtime, io: CliIo): number {
  const current = runtime.status();
  const activeTimers = runtime.timerStore.listActive().length;
  const pendingSync = runtime.timeEntryStore.pendingForSync().length;
  const lastSync = runtime.catalogStore.getLastProjectSync();
  io.out(
    [
      `Database: ${current.home}`,
      `Credentials: ${current.credentialSource ?? "none"}`,
      `active timers: ${activeTimers}`,
      `pending sync: ${pendingSync}`,
      `last project sync: ${lastSync ?? "never"}`,
    ].join(" | "),
  );
  return 0;
}

async function syncProjects(runtime: Runtime, io: CliIo): Promise<number> {
  if (!runtime.status().credentialsConfigured) {
    io.err("Intervals credentials are not configured. Run `intervals setup` first.");
    return 1;
  }
  return runCatalogSync(runtime, io);
}

async function syncNow(runtime: Runtime, io: CliIo): Promise<number> {
  const current = runtime.status();
  if (!current.credentialsConfigured || !current.personId) {
    io.err("Intervals credentials or person ID are not configured. Run `intervals setup` first.");
    return 1;
  }
  const result = await runtime.trySyncNow();
  io.out(`Sync complete | ${formatSyncSummary(result)}`);
  return 0;
}

async function timers(runtime: Runtime, io: CliIo, rest: string[]): Promise<number> {
  const [sub, ...args] = rest;

  if (sub === "edit") {
    const [localId, ...tokens] = args;
    if (!localId) {
      io.err("Usage: intervals timers edit <timer_id> [project_id=...] [worktype_id=...] [module_id=...|null] [description=...]");
      return 2;
    }
    const patch: Record<string, unknown> = { localId };
    for (const token of tokens) {
      const eq = token.indexOf("=");
      if (eq === -1) {
        io.err(`Invalid token (expected field=value): ${token}`);
        return 2;
      }
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key === "project_id" || key === "worktype_id") {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          io.err(`Invalid numeric value for ${key}: ${value}`);
          return 2;
        }
        patch[key === "project_id" ? "projectId" : "worktypeId"] = num;
      } else if (key === "module_id") {
        if (value === "" || value === "null") {
          patch.moduleId = null;
        } else {
          const num = Number(value);
          if (!Number.isFinite(num)) {
            io.err(`Invalid numeric value for module_id: ${value}`);
            return 2;
          }
          patch.moduleId = num;
        }
      } else if (key === "description") {
        patch.description = value;
      } else {
        io.err(`Unknown field: ${key}`);
        return 2;
      }
    }
    const timer = runtime.timerService.editTimer(patch as unknown as Parameters<typeof runtime.timerService.editTimer>[0]);
    io.out("Timer updated");
    io.out(formatTimer(withLinkedTimeEntryDuration(runtime.timeEntryStore, timer), new Date(), { bright: io.bright }));
    return 0;
  }

  if (sub === "delete") {
    const [localId] = args;
    if (!localId) {
      io.err("Usage: intervals timers delete <timer_id>");
      return 2;
    }
    const timer = runtime.timerService.deleteTimer({ localId });
    io.out("Timer deleted");
    io.out(formatTimer(withLinkedTimeEntryDuration(runtime.timeEntryStore, timer), new Date(), { bright: io.bright }));
    return 0;
  }

  if (sub !== undefined && sub !== "recent") {
    io.err(`Unknown timers subcommand: ${sub}`);
    return 2;
  }

  const list = sub === "recent" ? runtime.timerStore.listRecent(10) : runtime.timerStore.listActive();
  if (list.length === 0) {
    io.out("No timers found.");
    return 0;
  }
  const displayTimers = list.map((t) => withLinkedTimeEntryDuration(runtime.timeEntryStore, t));
  const lines =
    sub === "recent"
      ? formatTimerRowsByDate(displayTimers, new Date(), { bright: io.bright })
      : formatTimerRows(displayTimers, new Date(), { bright: io.bright });
  for (const line of lines) io.out(line);
  return 0;
}

async function time(runtime: Runtime, io: CliIo, rest: string[]): Promise<number> {
  if (rest[0] === "edit") {
    const [localId, ...tokens] = rest.slice(1);
    if (!localId) {
      io.err("Usage: intervals time edit <time_entry_id> [field=value ...]. Use stop_time=HH:mm to change the local stop time and recalculate duration.");
      return 2;
    }
    const patch: Record<string, unknown> = { localId };
    for (const token of tokens) {
      const eq = token.indexOf("=");
      if (eq === -1) {
        io.err(`Invalid token (expected field=value): ${token}`);
        return 2;
      }
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key === "duration_minutes") {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          io.err(`Invalid numeric value for duration_minutes: ${value}`);
          return 2;
        }
        patch.durationSeconds = Math.round(num * 60);
      } else if (key === "project_id" || key === "worktype_id") {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          io.err(`Invalid numeric value for ${key}: ${value}`);
          return 2;
        }
        patch[key === "project_id" ? "projectId" : "worktypeId"] = num;
      } else if (key === "module_id") {
        if (value === "" || value === "null") {
          patch.moduleId = null;
        } else {
          const num = Number(value);
          if (!Number.isFinite(num)) {
            io.err(`Invalid numeric value for module_id: ${value}`);
            return 2;
          }
          patch.moduleId = num;
        }
      } else if (key === "billable") {
        patch.billable = value === "true" || value === "1";
      } else if (key === "description") {
        patch.description = value;
      } else if (key === "date") {
        patch.date = value;
      } else if (key === "start_at") {
        patch.startAt = value === "" || value === "null" ? null : value;
      } else if (key === "end_at") {
        patch.endAt = value === "" || value === "null" ? null : value;
      } else if (key === "stop_time") {
        patch.stopTime = value;
      } else {
        io.err(`Unknown field: ${key}`);
        return 2;
      }
    }

    const existingEntry = patch.stopTime ? runtime.timeEntryStore.getTimeEntry(localId) : undefined;
    const entry = runtime.timeService.editTime(patch as unknown as Parameters<typeof runtime.timeService.editTime>[0]);
    const syncResult = await runtime.trySyncNow();
    io.out(`Updated ${formatEditableLocalId(entry.localId)}`);
    io.out(
      formatTimeEntry({
        ...entry,
        projectName: runtime.catalogStore.getProject(entry.projectId)?.name,
        worktypeName: runtime.catalogStore.getWorktype(entry.projectId, entry.worktypeId)?.name,
        moduleName: entry.moduleId != null ? runtime.catalogStore.getModule(entry.projectId, entry.moduleId)?.name : undefined,
      }),
    );
    if (patch.stopTime && existingEntry) {
      io.out(
        formatStopTimeEditSummary(
          buildStopTimeEditSummary({
            existingEntry,
            date: patch.date as string | undefined,
            startAt: patch.startAt as string | null | undefined,
            stopTime: patch.stopTime as string,
            roundedDurationSeconds: entry.durationSeconds,
          }),
        ),
      );
    }
    io.out(formatSyncSummary(syncResult));
    return 0;
  }

  let range: TimeRange = "today";
  let startDate: string | undefined;
  let endDate: string | undefined;
  const arg = rest[0] ?? "today";
  const normalized = arg.replace(/_/g, "-");

  if (normalized === "today") range = "today";
  else if (normalized === "yesterday") range = "yesterday";
  else if (normalized === "this-week") range = "this_week";
  else if (normalized === "last-week") range = "last_week";
  else if (normalized === "this-month") range = "this_month";
  else if (normalized === "last-month") range = "last_month";
  else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    range = "custom";
    startDate = arg;
    endDate = arg;
  } else if (arg.includes("..")) {
    const [start, end] = arg.split("..");
    range = "custom";
    startDate = start;
    endDate = end;
  } else {
    io.err(`Unknown range: ${arg}. Use today, yesterday, this-week, last-week, this-month, last-month, YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD`);
    return 2;
  }

  const report = runtime.timeService.queryTime({ range, start_date: startDate, end_date: endDate });
  io.out(formatTimeReport(report, { label: range.replace(/_/g, "-"), bright: io.bright }));
  return 0;
}

function projectDefaults(runtime: Runtime, io: CliIo, rest: string[]): number {
  if (rest.length < 2) {
    io.err("Usage: intervals project-defaults <project_id> <worktype_id> [module_id]");
    return 2;
  }
  const projectId = Number(rest[0]);
  const worktypeId = Number(rest[1]);
  if (!Number.isFinite(projectId) || !Number.isFinite(worktypeId)) {
    io.err("Invalid project_id or worktype_id: must be valid numbers.");
    return 2;
  }
  const moduleId = rest[2] != null ? Number(rest[2]) : undefined;
  if (rest[2] != null && !Number.isFinite(moduleId!)) {
    io.err("Invalid module_id: must be a valid number.");
    return 2;
  }
  runtime.defaultsStore.setProjectDefaults({
    projectId,
    defaultWorktypeId: worktypeId,
    defaultModuleId: moduleId,
  });
  io.out(`Project defaults set for ${projectId}: worktype=${worktypeId} module=${moduleId ?? "none"}`);
  return 0;
}
