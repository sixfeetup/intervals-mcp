import type { Db } from "./db.js";

export interface CatalogClient {
  id: number;
  name: string;
  active: boolean;
  raw: unknown;
}

export interface CatalogProject {
  id: number;
  clientId?: number;
  name: string;
  active: boolean;
  billable: boolean;
  raw: unknown;
}

export interface CatalogWorktype {
  id: number;
  projectId: number;
  worktypeId?: number;
  name: string;
  active: boolean;
  raw: unknown;
}

export interface CatalogModule {
  id: number;
  projectId: number;
  moduleId?: number;
  name: string;
  active: boolean;
  raw: unknown;
}

export interface ReplaceCatalogInput {
  clients: CatalogClient[];
  projects: CatalogProject[];
  worktypes: CatalogWorktype[];
  modules: CatalogModule[];
}

export interface ProjectContextResult {
  projectId: number;
  projectName: string;
  clientId?: number;
  clientName?: string;
  billable: boolean;
  worktypes: Array<{ id: number; worktypeId?: number; name: string; active: boolean }>;
  modules: Array<{ id: number; moduleId?: number; name: string; active: boolean }>;
}

function toInt(val: boolean): number {
  return val ? 1 : 0;
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bsysadmin\b/g, "system administration")
    .replace(/\bsys admin\b/g, "system administration")
    .replace(/\s+/g, " ")
    .trim();
}

function allTermsMatch(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(term));
}

function tokenizeNormalizedText(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export class CatalogStore {
  constructor(private readonly db: Db) {}

  replaceCatalog(input: ReplaceCatalogInput): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare("delete from project_modules").run();
      this.db.prepare("delete from project_worktypes").run();
      this.db.prepare("delete from projects").run();
      this.db.prepare("delete from clients").run();

      const insertClient = this.db.prepare(
        "insert into clients (id, name, active, raw_json, synced_at) values (?, ?, ?, ?, ?)"
      );
      for (const c of input.clients) {
        insertClient.run(c.id, c.name, toInt(c.active), JSON.stringify(c.raw), now);
      }

      const insertProject = this.db.prepare(
        "insert into projects (id, client_id, name, active, billable, raw_json, synced_at) values (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const p of input.projects) {
        insertProject.run(p.id, p.clientId ?? null, p.name, toInt(p.active), toInt(p.billable), JSON.stringify(p.raw), now);
      }

      const insertWorktype = this.db.prepare(
        "insert into project_worktypes (id, project_id, worktype_id, name, active, raw_json, synced_at) values (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const w of input.worktypes) {
        insertWorktype.run(w.id, w.projectId, w.worktypeId ?? null, w.name, toInt(w.active), JSON.stringify(w.raw), now);
      }

      const insertModule = this.db.prepare(
        "insert into project_modules (id, project_id, module_id, name, active, raw_json, synced_at) values (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const m of input.modules) {
        insertModule.run(m.id, m.projectId, m.moduleId ?? null, m.name, toInt(m.active), JSON.stringify(m.raw), now);
      }

      this.setLastProjectSync(now);
    });
    tx();
  }

  searchProjectContext(options: {
    query?: string;
    projectId?: number;
    clientId?: number;
    limit?: number;
  } = {}): ProjectContextResult[] {
    const limit = options.limit ?? 20;
    const fullQuery = normalizeSearchText(options.query ?? "");

    let where = "1 = 1";
    const params: (string | number | null)[] = [];

    if (options.projectId != null) {
      where += " and p.id = ?";
      params.push(options.projectId);
    }
    if (options.clientId != null) {
      where += " and p.client_id = ?";
      params.push(options.clientId);
    }

    const projectQuery = `select
          p.id as projectId,
          p.name as projectName,
          p.billable as billable,
          c.id as clientId,
          c.name as clientName,
          coalesce(group_concat(distinct wt.name), '') as worktypeNames,
          coalesce(group_concat(distinct pm.name), '') as moduleNames
        from projects p
        left join clients c on c.id = p.client_id
        left join project_worktypes wt on wt.project_id = p.id
        left join project_modules pm on pm.project_id = p.id
        where ${where}
        group by p.id, p.name, p.billable, c.id, c.name
        order by p.name`;

    const projectRows = this.db
      .prepare(fullQuery ? projectQuery : `${projectQuery}\n        limit ?`)
      .all(...(fullQuery ? params : [...params, limit])) as Array<{
        projectId: number;
        projectName: string;
        billable: number;
        clientId: number | null;
        clientName: string | null;
        worktypeNames: string;
        moduleNames: string;
      }>;

    const matchedRows = !fullQuery
      ? projectRows
      : projectRows
          .map((row) => {
            const normalizedProjectName = normalizeSearchText(row.projectName);
            const normalizedClientName = normalizeSearchText(row.clientName ?? "");
            const projectAndClientText = `${normalizedProjectName} ${normalizedClientName}`.trim();
            const searchableText = normalizeSearchText(
              `${row.projectName} ${row.clientName ?? ""} ${row.worktypeNames} ${row.moduleNames}`
            );
            const terms = fullQuery.split(/\s+/).filter(Boolean);
            const projectTokens = new Set(tokenizeNormalizedText(normalizedProjectName));
            const exactProjectTokenMatches = terms.filter((term) => projectTokens.has(term)).length;
            const score = (normalizedProjectName.includes(fullQuery)
              ? 100
              : allTermsMatch(normalizedProjectName, terms)
                ? 80
                : allTermsMatch(projectAndClientText, terms)
                  ? 60
                  : allTermsMatch(searchableText, terms)
                    ? 40
                    : 0) + exactProjectTokenMatches * 20;

            return { row, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.row.projectName.localeCompare(b.row.projectName))
          .slice(0, limit)
          .map((entry) => entry.row);

    const wtStmt = this.db.prepare(
      "select id, worktype_id as worktypeId, name, active from project_worktypes where project_id = ? order by name"
    );
    const modStmt = this.db.prepare(
      "select id, module_id as moduleId, name, active from project_modules where project_id = ? order by name"
    );

    return matchedRows.map((row) => {
      const worktypes = wtStmt.all(row.projectId) as Array<{ id: number; worktypeId: number | null; name: string; active: number }>;
      const modules = modStmt.all(row.projectId) as Array<{ id: number; moduleId: number | null; name: string; active: number }>;

      return {
        projectId: row.projectId,
        projectName: row.projectName,
        clientId: row.clientId ?? undefined,
        clientName: row.clientName ?? undefined,
        billable: row.billable === 1,
        worktypes: worktypes.map((w) => ({
          id: w.id,
          worktypeId: w.worktypeId ?? undefined,
          name: w.name,
          active: w.active === 1,
        })),
        modules: modules.map((m) => ({
          id: m.id,
          moduleId: m.moduleId ?? undefined,
          name: m.name,
          active: m.active === 1,
        })),
      };
    });
  }

  getProject(projectId: number): { id: number; clientId?: number; name: string; active: boolean; billable: boolean } | undefined {
    const row = this.db
      .prepare("select id, client_id as clientId, name, active, billable from projects where id = ?")
      .get(projectId) as { id: number; clientId: number | null; name: string; active: number; billable: number } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      clientId: row.clientId ?? undefined,
      name: row.name,
      active: row.active === 1,
      billable: row.billable === 1,
    };
  }

  getWorktype(
    projectId: number,
    worktypeId: number
  ): { id: number; projectId: number; worktypeId?: number; name: string; active: boolean } | undefined {
    const row = this.db
      .prepare(
        "select id, project_id as projectId, worktype_id as worktypeId, name, active from project_worktypes where project_id = ? and worktype_id = ?"
      )
      .get(projectId, worktypeId) as
      | { id: number; projectId: number; worktypeId: number | null; name: string; active: number }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.projectId,
      worktypeId: row.worktypeId ?? undefined,
      name: row.name,
      active: row.active === 1,
    };
  }

  getModule(
    projectId: number,
    moduleId: number
  ): { id: number; projectId: number; moduleId?: number; name: string; active: boolean } | undefined {
    const row = this.db
      .prepare(
        "select id, project_id as projectId, module_id as moduleId, name, active from project_modules where project_id = ? and module_id = ?"
      )
      .get(projectId, moduleId) as
      | { id: number; projectId: number; moduleId: number | null; name: string; active: number }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.projectId,
      moduleId: row.moduleId ?? undefined,
      name: row.name,
      active: row.active === 1,
    };
  }

  setLastProjectSync(iso: string): void {
    this.db
      .prepare(
        "insert into settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
      )
      .run("last_project_sync", iso, iso);
  }

  getLastProjectSync(): string | undefined {
    const row = this.db
      .prepare("select value from settings where key = ?")
      .get("last_project_sync") as { value: string } | undefined;
    return row?.value;
  }
}
