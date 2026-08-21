export type SyncStatus = "pending" | "synced" | "failed" | "needs_review";
export type TimerState = "active" | "stopped";
export type TimeRange = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "custom";

export interface ProjectContext {
  projectId: number;
  projectName: string;
  clientId?: number;
  clientName?: string;
  worktypeId?: number;
  worktypeName?: string;
  moduleId?: number;
  moduleName?: string;
}
