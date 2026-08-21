import type { Db } from "./db.js";

export class ProjectDefaultsStore {
  constructor(private readonly db: Db) {}

  setProjectDefaults(input: { projectId: number; defaultWorktypeId?: number; defaultModuleId?: number }): void {
    this.db.prepare(`
      insert into project_defaults(project_id, default_worktype_id, default_module_id, updated_at)
      values (?, ?, ?, ?)
      on conflict(project_id) do update set
        default_worktype_id = excluded.default_worktype_id,
        default_module_id = excluded.default_module_id,
        updated_at = excluded.updated_at
    `).run(input.projectId, input.defaultWorktypeId ?? null, input.defaultModuleId ?? null, new Date().toISOString());
  }

  getProjectDefaults(projectId: number): { worktypeId?: number; moduleId?: number } | undefined {
    const row = this.db.prepare("select default_worktype_id as worktypeId, default_module_id as moduleId from project_defaults where project_id = ?").get(projectId) as { worktypeId: number | null; moduleId: number | null } | undefined;
    if (!row) return undefined;
    return { worktypeId: row.worktypeId ?? undefined, moduleId: row.moduleId ?? undefined };
  }

  resolveForProject(input: { projectId: number; worktypeId?: number; moduleId?: number }): { worktypeId?: number; moduleId?: number } {
    const defaults = this.getProjectDefaults(input.projectId);
    return {
      worktypeId: input.worktypeId ?? defaults?.worktypeId,
      moduleId: input.moduleId ?? defaults?.moduleId,
    };
  }
}
