import { Type, type Static, type TObject, type TSchema } from "typebox";
import {
  formatDuration,
  formatSyncSummary,
  formatTimeEntry,
  formatTimeReport,
  formatTimer,
  formatTimerRows,
  formatTimerRowsByDate,
} from "../domain/format.js";
import { formatEditableLocalId } from "../domain/local-id.js";
import type { Runtime } from "../domain/runtime.js";
import { parseTimerStartAt } from "../domain/start-at.js";
import { buildStopTimeEditSummary, formatStopTimeEditSummary } from "../domain/time-edit-feedback.js";
import { withLinkedTimeEntryDuration } from "../domain/timer-display.js";

export interface ToolResult {
  text: string;
  details: unknown;
}

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

function tool<S extends TObject>(descriptor: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  execute(params: Static<S>): Promise<ToolResult>;
}): ToolDescriptor {
  return descriptor as unknown as ToolDescriptor;
}

function textResult(text: string, details?: unknown): ToolResult {
  return { text, details: details ?? {} };
}

function resolveProjectQuery(runtime: Runtime, projectQuery: string | undefined): number | undefined {
  if (!projectQuery) return undefined;
  const matches = runtime.catalogStore.searchProjectContext({ query: projectQuery, limit: 5 });
  if (matches.length === 0) {
    throw new Error(`no project found for query: ${projectQuery}`);
  }
  if (matches.length > 1) {
    throw new Error(`project query is ambiguous: ${projectQuery} (${matches.length} matches)`);
  }
  return matches[0].projectId;
}

export function createToolDescriptors(runtime: Runtime): ToolDescriptor[] {
  return [
    tool({
      name: "find_project_context",
      title: "Find Intervals project context",
      description:
        "Search local Intervals project catalog for projects, worktypes, and modules. Returns matching projects with their classifications. This is local-only and does not call the Intervals API.",
      inputSchema: Type.Object({
        query: Type.Optional(Type.String({ description: "Free-text search across project and client names" })),
        project_id: Type.Optional(Type.Number({ description: "Exact project ID to look up" })),
        limit: Type.Optional(Type.Number({ description: "Maximum results to return", default: 20 })),
      }),
      execute: async (params) => {
        const results = runtime.catalogStore.searchProjectContext({
          query: params.query,
          projectId: params.project_id,
          limit: params.limit ?? 20,
        });
        const lines = results.map((r) => {
          const wts = r.worktypes.map((w) => `${w.worktypeId ?? w.id} ${w.name}`).join(", ") || "none";
          const mods = r.modules.map((m) => `${m.moduleId ?? m.id} ${m.name}`).join(", ") || "none";
          return `${r.projectId}: ${r.projectName} (${r.clientName ?? "no client"}) — worktypes: ${wts}; modules: ${mods}`;
        });
        return textResult(lines.join("\n") || "No projects found.", { results });
      },
    }),

    tool({
      name: "start_timer",
      title: "Start Intervals timer",
      description:
        "Start a local timer to capture work in progress. Only a description is required. Optional project, worktype, module, and start_at hints can be provided but are not required. Timers are local-only and are not synced to Intervals until stopped. IMPORTANT: Never start a timer implicitly — only call this when the user explicitly asked to start a timer or answered yes when asked. Before starting, check active timers with list_timers; if one is running, ask the user whether to stop it first.",
      inputSchema: Type.Object({
        description: Type.String({ description: "Short description of the work being performed" }),
        project_id: Type.Optional(Type.Number({ description: "Optional project ID hint" })),
        project_query: Type.Optional(Type.String({ description: "Optional project search query to resolve a project ID" })),
        worktype_id: Type.Optional(Type.Number({ description: "Optional worktype ID hint" })),
        module_id: Type.Optional(Type.Number({ description: "Optional module ID hint" })),
        start_at: Type.Optional(Type.String({ description: "Optional start time. Accepts HH:mm for today in local time, YYYY-MM-DD HH:mm for local date/time, or an ISO datetime." })),
        notes: Type.Optional(Type.String({ description: "Optional notes for the timer" })),
      }),
      execute: async (params) => {
        const projectId = resolveProjectQuery(runtime, params.project_query) ?? params.project_id;
        const now = params.start_at !== undefined ? parseTimerStartAt(params.start_at) : undefined;
        const timer = runtime.timerService.startTimer({
          description: params.description,
          projectId,
          worktypeId: params.worktype_id,
          moduleId: params.module_id,
          notes: params.notes,
          now,
        });
        return textResult(formatTimer(timer), { timer });
      },
    }),

    tool({
      name: "stop_timer",
      title: "Stop Intervals timer",
      description:
        "Stop a local timer and convert it into a pending time entry. You must provide or resolve the project and worktype. The resulting time entry is then synced to Intervals.",
      inputSchema: Type.Object({
        timer_id: Type.String({ description: "Local ID of the active timer to stop" }),
        project_id: Type.Optional(Type.Number({ description: "Project ID for the time entry" })),
        project_query: Type.Optional(Type.String({ description: "Project search query to resolve the project" })),
        worktype_id: Type.Optional(Type.Number({ description: "Worktype ID for the time entry" })),
        module_id: Type.Optional(Type.Number({ description: "Module ID for the time entry" })),
        description: Type.Optional(Type.String({ description: "Override description for the time entry" })),
        billable: Type.Optional(Type.Boolean({ description: "Optional billable override. When omitted, the project's catalog billable setting is used." })),
      }),
      execute: async (params) => {
        const projectId = resolveProjectQuery(runtime, params.project_query) ?? params.project_id;
        const entry = runtime.timerService.stopTimer({
          localId: params.timer_id,
          projectId,
          worktypeId: params.worktype_id,
          moduleId: params.module_id,
          description: params.description,
          billable: params.billable,
        });
        const syncResult = await runtime.trySyncNow();
        const projectName = runtime.catalogStore.getProject(entry.projectId)?.name ?? `Project ${entry.projectId}`;
        const worktypeName = runtime.catalogStore.getWorktype(entry.projectId, entry.worktypeId)?.name ?? `Worktype ${entry.worktypeId}`;
        const dur = formatDuration(entry.durationSeconds);
        return textResult(
          `Timer stopped → ${entry.localId}\n${entry.date} ${dur} ${projectName} (${worktypeName})${entry.description ? ` | ${entry.description}` : ""}\n${formatSyncSummary(syncResult)}`,
          { entry, sync: syncResult },
        );
      },
    }),

    tool({
      name: "edit_timer",
      title: "Edit Intervals timer",
      description:
        "Update a running local timer's project, worktype, or module hints. This is local-only and affects the time entry created when the timer is stopped.",
      inputSchema: Type.Object({
        timer_id: Type.String({ description: "Local ID of the active timer to edit" }),
        project_id: Type.Optional(Type.Number({ description: "Project ID hint for the timer" })),
        project_query: Type.Optional(Type.String({ description: "Project search query to resolve the project" })),
        worktype_id: Type.Optional(Type.Number({ description: "Worktype ID hint for the timer" })),
        module_id: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Module ID hint, or null to clear" })),
        description: Type.Optional(Type.String({ description: "New timer description" })),
      }),
      execute: async (params) => {
        const projectId = resolveProjectQuery(runtime, params.project_query) ?? params.project_id;
        const patch: Parameters<typeof runtime.timerService.editTimer>[0] = { localId: params.timer_id };
        if (projectId !== undefined) patch.projectId = projectId;
        if (params.worktype_id !== undefined) patch.worktypeId = params.worktype_id;
        if (params.module_id !== undefined) patch.moduleId = params.module_id;
        if (params.description !== undefined) patch.description = params.description;
        const timer = runtime.timerService.editTimer(patch);
        return textResult(`Timer updated → ${formatTimer(timer)}`, { timer });
      },
    }),

    tool({
      name: "delete_timer",
      title: "Delete Intervals timer",
      description:
        "Delete a local timer safely. Active timers can be discarded. Stopped timers can only be deleted when they do not have a linked time entry.",
      inputSchema: Type.Object({
        timer_id: Type.String({ description: "Local ID of the timer to delete" }),
      }),
      execute: async (params) => {
        const timer = runtime.timerService.deleteTimer({ localId: params.timer_id });
        return textResult(`Timer deleted → ${formatTimer(timer)}`, { timer });
      },
    }),

    tool({
      name: "add_time",
      title: "Add Intervals time entry",
      description:
        "Add a time entry directly without using a timer. Duration is given in minutes and converted to seconds locally. The entry is created as pending and will sync on the next sync pass.",
      inputSchema: Type.Object({
        project_id: Type.Number({ description: "Project ID for the time entry" }),
        worktype_id: Type.Optional(Type.Number({ description: "Worktype ID (required if no project default is set)" })),
        module_id: Type.Optional(Type.Number({ description: "Module ID" })),
        date: Type.String({ description: "Date for the time entry (YYYY-MM-DD)" }),
        duration_minutes: Type.Number({ description: "Duration in minutes (will be converted to seconds)" }),
        description: Type.Optional(Type.String({ description: "Description of the work" })),
        billable: Type.Optional(Type.Boolean({ description: "Optional billable override. When omitted, the project's catalog billable setting is used." })),
      }),
      execute: async (params) => {
        const entry = runtime.timeService.addTime({
          projectId: params.project_id,
          worktypeId: params.worktype_id,
          moduleId: params.module_id,
          date: params.date,
          durationSeconds: Math.round(params.duration_minutes * 60),
          description: params.description,
          billable: params.billable,
        });
        return textResult(
          `${entry.localId}\n${formatTimeEntry({
            ...entry,
            projectName: runtime.catalogStore.getProject(entry.projectId)?.name,
            worktypeName: runtime.catalogStore.getWorktype(entry.projectId, entry.worktypeId)?.name,
            moduleName: entry.moduleId != null
              ? runtime.catalogStore.getModule(entry.projectId, entry.moduleId)?.name
              : undefined,
          })}`,
          { entry },
        );
      },
    }),

    tool({
      name: "edit_time",
      title: "Edit Intervals time entry",
      description:
        "Edit an existing local time entry. If duration_minutes is provided, it is converted to seconds. The entry is marked pending and time-entry sync is triggered. If the entry was previously synced, it will be updated via PUT on the next sync. When the user gives a bare local stop time such as 08:35, pass stop_time (HH:mm) rather than end_at — stop_time recalculates duration from the entry's stored start time; setting end_at alone does not update the duration.",
      inputSchema: Type.Object({
        time_entry_id: Type.Optional(Type.String({ description: "Local ID of the time entry to edit. Optional when timer_id is provided." })),
        project_id: Type.Optional(Type.Number({ description: "New project ID" })),
        project_query: Type.Optional(Type.String({ description: "Project search query to resolve a new project" })),
        worktype_id: Type.Optional(Type.Number({ description: "New worktype ID" })),
        module_id: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "New module ID, or null to clear" })),
        date: Type.Optional(Type.String({ description: "New date (YYYY-MM-DD)" })),
        start_at: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "New start time, or null to clear" })),
        end_at: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "New end time, or null to clear" })),
        stop_time: Type.Optional(Type.String({ description: "Local stop time as HH:mm. Recalculates duration from start_at and updates end_at." })),
        timer_id: Type.Optional(Type.String({ description: "Source timer ID for the time entry to edit, mutually exclusive with time_entry_id" })),
        duration_minutes: Type.Optional(Type.Number({ description: "New duration in minutes (converted to seconds)" })),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "New description, or null to clear" })),
        billable: Type.Optional(Type.Boolean({ description: "Whether the entry is billable" })),
      }),
      execute: async (params) => {
        if (params.time_entry_id && params.timer_id) {
          throw new Error("cannot specify both time_entry_id and timer_id");
        }
        if (!params.time_entry_id && !params.timer_id) {
          throw new Error("time_entry_id or timer_id is required");
        }

        const linkedEntry = params.timer_id ? runtime.timeEntryStore.findBySourceTimerId(params.timer_id) : undefined;
        const localId = params.time_entry_id
          ?? (() => {
            if (!linkedEntry) throw new Error(`no time entry linked to timer: ${params.timer_id}`);
            return linkedEntry.localId;
          })();
        const existingEntry = params.stop_time ? linkedEntry ?? runtime.timeEntryStore.getTimeEntry(localId) : undefined;

        const entry = runtime.timeService.editTime({
          localId,
          projectId: params.project_id,
          projectQuery: params.project_query,
          worktypeId: params.worktype_id,
          moduleId: params.module_id,
          date: params.date,
          startAt: params.start_at,
          endAt: params.end_at,
          stopTime: params.stop_time,
          durationSeconds: params.duration_minutes != null ? Math.round(params.duration_minutes * 60) : undefined,
          description: params.description,
          billable: params.billable,
        });
        const syncResult = await runtime.trySyncNow();
        const lines = [`Time entry updated: ${formatEditableLocalId(entry.localId)}`];
        if (params.stop_time && existingEntry) {
          lines.push(formatStopTimeEditSummary(buildStopTimeEditSummary({
            existingEntry,
            date: params.date,
            startAt: params.start_at,
            stopTime: params.stop_time,
            roundedDurationSeconds: entry.durationSeconds,
          })));
        }
        lines.push(formatSyncSummary(syncResult));
        return textResult(lines.join("\n"), { entry, sync: syncResult });
      },
    }),

    tool({
      name: "delete_time",
      title: "Delete Intervals time entry",
      description:
        "Delete an existing local time entry. Unsynced local entries are removed locally. Synced entries are deleted from Intervals first, then removed locally. The entry can be identified by time_entry_id or by a linked source timer_id.",
      inputSchema: Type.Object({
        time_entry_id: Type.Optional(Type.String({ description: "Local ID of the time entry to delete. Optional when timer_id is provided." })),
        timer_id: Type.Optional(Type.String({ description: "Source timer ID for the time entry to delete, mutually exclusive with time_entry_id" })),
      }),
      execute: async (params) => {
        if (params.time_entry_id && params.timer_id) {
          throw new Error("cannot specify both time_entry_id and timer_id");
        }
        if (!params.time_entry_id && !params.timer_id) {
          throw new Error("time_entry_id or timer_id is required");
        }

        const linkedEntry = params.timer_id ? runtime.timeEntryStore.findBySourceTimerId(params.timer_id) : undefined;
        const localId = params.time_entry_id
          ?? (() => {
            if (!linkedEntry) throw new Error(`no time entry linked to timer: ${params.timer_id}`);
            return linkedEntry.localId;
          })();

        const entry = await runtime.deleteTimeEntry(localId);
        const deleted = formatTimeEntry({
          ...entry,
          projectName: runtime.catalogStore.getProject(entry.projectId)?.name,
          worktypeName: runtime.catalogStore.getWorktype(entry.projectId, entry.worktypeId)?.name,
          moduleName: entry.moduleId != null
            ? runtime.catalogStore.getModule(entry.projectId, entry.moduleId)?.name
            : undefined,
        });
        return textResult(`Time entry deleted: ${formatEditableLocalId(entry.localId)}\n${deleted}`, { entry });
      },
    }),

    tool({
      name: "query_time",
      title: "Query Intervals time entries",
      description:
        "Query local time entries by date range and optional project filter. This is local-only and does not call the Intervals API. Use it for reporting and summaries.",
      inputSchema: Type.Object({
        range: Type.Union(
          [
            Type.Literal("today"),
            Type.Literal("yesterday"),
            Type.Literal("this_week"),
            Type.Literal("last_week"),
            Type.Literal("this_month"),
            Type.Literal("last_month"),
            Type.Literal("custom"),
          ],
          { description: "Predefined date range" },
        ),
        start_date: Type.Optional(Type.String({ description: "Required when range=custom (YYYY-MM-DD)" })),
        end_date: Type.Optional(Type.String({ description: "Required when range=custom (YYYY-MM-DD)" })),
        project_id: Type.Optional(Type.Number({ description: "Filter by project ID" })),
        project_query: Type.Optional(Type.String({ description: "Filter by project query (resolved to a single project)" })),
      }),
      execute: async (params) => {
        const report = runtime.timeService.queryTime({
          range: params.range,
          start_date: params.start_date,
          end_date: params.end_date,
          projectId: params.project_id,
          projectQuery: params.project_query,
        });
        return textResult(formatTimeReport(report), { report });
      },
    }),

    tool({
      name: "list_timers",
      title: "List Intervals timers",
      description: "List active or recent local timers. Useful for showing the user what timers are running or were recently stopped.",
      inputSchema: Type.Object({
        state: Type.Optional(
          Type.Union([Type.Literal("active"), Type.Literal("recent")], {
            description: "Filter by timer state",
            default: "active",
          }),
        ),
        limit: Type.Optional(Type.Number({ description: "Maximum results", default: 20 })),
      }),
      execute: async (params) => {
        const timers =
          params.state === "recent"
            ? runtime.timerStore.listRecent(params.limit ?? 20)
            : runtime.timerStore.listActive();
        const displayTimers = timers.map((t) => withLinkedTimeEntryDuration(runtime.timeEntryStore, t));
        const lines = params.state === "recent" ? formatTimerRowsByDate(displayTimers) : formatTimerRows(displayTimers);
        return textResult(lines.join("\n") || "No timers found.", { timers });
      },
    }),

    tool({
      name: "lookup_time_entry",
      title: "Lookup Intervals time entry",
      description: "Find the local time entry ID linked to a stopped local timer. Agent-facing lookup to avoid SQLite inspection.",
      inputSchema: Type.Object({
        timer_id: Type.String({ description: "Local timer ID" }),
      }),
      execute: async (params) => {
        const entry = runtime.timeEntryStore.findBySourceTimerId(params.timer_id);
        if (!entry) throw new Error(`no time entry linked to timer: ${params.timer_id}`);
        const timeEntryId = formatEditableLocalId(entry.localId);
        return textResult(`time_entry_id: ${timeEntryId}`, {
          timeEntryId,
          timerId: params.timer_id,
        });
      },
    }),

    tool({
      name: "list_time",
      title: "List recent Intervals time entries",
      description: "List recent local time entries, including their sync status. Useful for reviewing recently logged time.",
      inputSchema: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum results", default: 20 })),
      }),
      execute: async (params) => {
        const entries = runtime.timeEntryStore.listRecent({ limit: params.limit ?? 20 });
        const lines = entries.map((e) => formatTimeEntry({
          ...e,
          projectName: runtime.catalogStore.getProject(e.projectId)?.name,
          worktypeName: runtime.catalogStore.getWorktype(e.projectId, e.worktypeId)?.name,
          moduleName: e.moduleId != null
            ? runtime.catalogStore.getModule(e.projectId, e.moduleId)?.name
            : undefined,
        }));
        return textResult(lines.join("\n") || "No time entries found.", { entries });
      },
    }),

    tool({
      name: "set_project_defaults",
      title: "Set Intervals project defaults",
      description:
        "Set the default worktype and optional module for a project. These defaults are used when starting timers or adding time entries without explicit worktype/module IDs.",
      inputSchema: Type.Object({
        project_id: Type.Number({ description: "Project ID" }),
        worktype_id: Type.Optional(Type.Number({ description: "Default worktype ID" })),
        module_id: Type.Optional(Type.Number({ description: "Default module ID" })),
      }),
      execute: async (params) => {
        runtime.defaultsStore.setProjectDefaults({
          projectId: params.project_id,
          defaultWorktypeId: params.worktype_id,
          defaultModuleId: params.module_id,
        });
        return textResult(
          `Project defaults set for project ${params.project_id}: worktype=${params.worktype_id ?? "unset"} module=${params.module_id ?? "unset"}`,
          { projectId: params.project_id, worktypeId: params.worktype_id, moduleId: params.module_id },
        );
      },
    }),

    tool({
      name: "sync_now",
      title: "Sync Intervals time entries now",
      description:
        "Immediately attempt to sync pending local time entries to Intervals. Returns counts of created, updated, and failed entries.",
      inputSchema: Type.Object({}),
      execute: async () => {
        const result = await runtime.trySyncNow();
        return textResult(`Sync complete | ${formatSyncSummary(result)}`, result);
      },
    }),
  ];
}
