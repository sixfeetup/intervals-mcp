import type { CatalogStore } from "./catalog-store.js";

export interface SyncApi {
  listResource(resource: string): Promise<unknown[]>;
}

export interface SyncResult {
  clients: number;
  projects: number;
  worktypes: number;
  modules: number;
}

function normalizeBoolean(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    return val === "t" || val === "true" || val === "1";
  }
  return false;
}

function normalizeActive(val: unknown): boolean {
  // Intervals normally sends active as "t"/"f". If a fixture or future endpoint omits
  // the field, treat it as active rather than accidentally dropping the whole catalog.
  if (val == null) return true;
  return normalizeBoolean(val);
}

function getString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function getNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const parsed = Number(val);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

export async function syncProjectsCatalog(api: SyncApi, store: CatalogStore): Promise<SyncResult> {
  const rawClients = await api.listResource("client");
  const rawProjects = await api.listResource("project");
  const rawWorktypes = await api.listResource("projectworktype");
  const rawModules = await api.listResource("projectmodule");

  const clients = rawClients.map((c) => {
    const obj = c as Record<string, unknown>;
    return {
      id: getNumber(obj, "id") ?? 0,
      name: getString(obj, "name") ?? "",
      active: normalizeActive(obj.active),
      raw: c,
    };
  });

  const projects = rawProjects.map((p) => {
    const obj = p as Record<string, unknown>;
    return {
      id: getNumber(obj, "id") ?? 0,
      clientId: getNumber(obj, "clientid", "client_id") ?? undefined,
      name: getString(obj, "name") ?? "",
      active: normalizeActive(obj.active),
      billable: normalizeBoolean(obj.billable),
      raw: p,
    };
  });

  const worktypes = rawWorktypes.map((w) => {
    const obj = w as Record<string, unknown>;
    return {
      id: getNumber(obj, "id") ?? 0,
      projectId: getNumber(obj, "projectid", "project_id") ?? 0,
      worktypeId: getNumber(obj, "worktypeid", "worktype_id") ?? undefined,
      name: getString(obj, "worktype", "name", "worktypename") ?? "",
      active: normalizeActive(obj.active),
      raw: w,
    };
  });

  const modules = rawModules.map((m) => {
    const obj = m as Record<string, unknown>;
    return {
      id: getNumber(obj, "id") ?? 0,
      projectId: getNumber(obj, "projectid", "project_id") ?? 0,
      moduleId: getNumber(obj, "moduleid", "module_id") ?? undefined,
      name: getString(obj, "module", "name", "modulename") ?? "",
      active: normalizeActive(obj.active),
      raw: m,
    };
  });

  const activeProjects = projects.filter((p) => p.active);
  const activeProjectIds = new Set(activeProjects.map((p) => p.id));
  const referencedClientIds = new Set(
    activeProjects
      .map((p) => p.clientId)
      .filter((id): id is number => id != null),
  );

  const retainedClients = clients.filter((c) => c.active || referencedClientIds.has(c.id));
  const activeWorktypes = worktypes.filter((w) => w.active && activeProjectIds.has(w.projectId));
  const activeModules = modules.filter((m) => m.active && activeProjectIds.has(m.projectId));

  store.replaceCatalog({
    clients: retainedClients,
    projects: activeProjects,
    worktypes: activeWorktypes,
    modules: activeModules,
  });

  return {
    clients: retainedClients.length,
    projects: activeProjects.length,
    worktypes: activeWorktypes.length,
    modules: activeModules.length,
  };
}
