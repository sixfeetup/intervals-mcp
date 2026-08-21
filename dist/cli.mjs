#!/usr/bin/env node

// src/domain/runtime.ts
import { randomUUID } from "node:crypto";

// src/domain/background-sync.ts
function startBackgroundSync(options) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await options.syncNow();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, options.intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
    tick
  };
}

// src/domain/catalog-store.ts
function toInt(val) {
  return val ? 1 : 0;
}
function normalizeSearchText(text) {
  return text.toLowerCase().replace(/&amp;/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/\bsysadmin\b/g, "system administration").replace(/\bsys admin\b/g, "system administration").replace(/\s+/g, " ").trim();
}
function allTermsMatch(text, terms) {
  return terms.every((term) => text.includes(term));
}
function tokenizeNormalizedText(text) {
  return text.split(/\s+/).filter(Boolean);
}
var CatalogStore = class {
  constructor(db) {
    this.db = db;
  }
  db;
  replaceCatalog(input) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
  searchProjectContext(options = {}) {
    const limit = options.limit ?? 20;
    const fullQuery = normalizeSearchText(options.query ?? "");
    let where = "1 = 1";
    const params = [];
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
    const projectRows = this.db.prepare(fullQuery ? projectQuery : `${projectQuery}
        limit ?`).all(...fullQuery ? params : [...params, limit]);
    const matchedRows = !fullQuery ? projectRows : projectRows.map((row) => {
      const normalizedProjectName = normalizeSearchText(row.projectName);
      const normalizedClientName = normalizeSearchText(row.clientName ?? "");
      const projectAndClientText = `${normalizedProjectName} ${normalizedClientName}`.trim();
      const searchableText = normalizeSearchText(
        `${row.projectName} ${row.clientName ?? ""} ${row.worktypeNames} ${row.moduleNames}`
      );
      const terms = fullQuery.split(/\s+/).filter(Boolean);
      const projectTokens = new Set(tokenizeNormalizedText(normalizedProjectName));
      const exactProjectTokenMatches = terms.filter((term) => projectTokens.has(term)).length;
      const score = (normalizedProjectName.includes(fullQuery) ? 100 : allTermsMatch(normalizedProjectName, terms) ? 80 : allTermsMatch(projectAndClientText, terms) ? 60 : allTermsMatch(searchableText, terms) ? 40 : 0) + exactProjectTokenMatches * 20;
      return { row, score };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.row.projectName.localeCompare(b.row.projectName)).slice(0, limit).map((entry) => entry.row);
    const wtStmt = this.db.prepare(
      "select id, worktype_id as worktypeId, name, active from project_worktypes where project_id = ? order by name"
    );
    const modStmt = this.db.prepare(
      "select id, module_id as moduleId, name, active from project_modules where project_id = ? order by name"
    );
    return matchedRows.map((row) => {
      const worktypes = wtStmt.all(row.projectId);
      const modules = modStmt.all(row.projectId);
      return {
        projectId: row.projectId,
        projectName: row.projectName,
        clientId: row.clientId ?? void 0,
        clientName: row.clientName ?? void 0,
        billable: row.billable === 1,
        worktypes: worktypes.map((w) => ({
          id: w.id,
          worktypeId: w.worktypeId ?? void 0,
          name: w.name,
          active: w.active === 1
        })),
        modules: modules.map((m) => ({
          id: m.id,
          moduleId: m.moduleId ?? void 0,
          name: m.name,
          active: m.active === 1
        }))
      };
    });
  }
  getProject(projectId) {
    const row = this.db.prepare("select id, client_id as clientId, name, active, billable from projects where id = ?").get(projectId);
    if (!row) return void 0;
    return {
      id: row.id,
      clientId: row.clientId ?? void 0,
      name: row.name,
      active: row.active === 1,
      billable: row.billable === 1
    };
  }
  getWorktype(projectId, worktypeId) {
    const row = this.db.prepare(
      "select id, project_id as projectId, worktype_id as worktypeId, name, active from project_worktypes where project_id = ? and worktype_id = ?"
    ).get(projectId, worktypeId);
    if (!row) return void 0;
    return {
      id: row.id,
      projectId: row.projectId,
      worktypeId: row.worktypeId ?? void 0,
      name: row.name,
      active: row.active === 1
    };
  }
  getModule(projectId, moduleId) {
    const row = this.db.prepare(
      "select id, project_id as projectId, module_id as moduleId, name, active from project_modules where project_id = ? and module_id = ?"
    ).get(projectId, moduleId);
    if (!row) return void 0;
    return {
      id: row.id,
      projectId: row.projectId,
      moduleId: row.moduleId ?? void 0,
      name: row.name,
      active: row.active === 1
    };
  }
  setLastProjectSync(iso) {
    this.db.prepare(
      "insert into settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
    ).run("last_project_sync", iso, iso);
  }
  getLastProjectSync() {
    const row = this.db.prepare("select value from settings where key = ?").get("last_project_sync");
    return row?.value;
  }
};

// src/domain/config.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
var DEFAULT_INTERVALS_BASE_URL = "https://api.myintervals.com/";
function getIntervalsHome(env = process.env) {
  return resolve(env.INTERVALS_HOME || join(homedir(), ".intervals"));
}
function configPath(home) {
  return join(home, "config.json");
}
function databasePath(home) {
  return join(home, "intervals.db");
}
function ensureIntervalsHome(home) {
  mkdirSync(home, { recursive: true });
}
function loadConfig(home) {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}
function saveConfig(home, config) {
  ensureIntervalsHome(home);
  const path = configPath(home);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
  chmodSync(path, 384);
}
function resolveCredentials(config, env = process.env) {
  const envKey = env.INTERVALS_API_KEY;
  if (envKey) {
    return { apiKey: envKey, baseUrl: env.INTERVALS_BASE_URL || config.baseUrl || DEFAULT_INTERVALS_BASE_URL, source: "env" };
  }
  if (config.apiKey) {
    return { apiKey: config.apiKey, baseUrl: config.baseUrl || DEFAULT_INTERVALS_BASE_URL, source: "config" };
  }
  return void 0;
}
function resolvePersonId(config, env = process.env) {
  const envPerson = env.INTERVALS_PERSON_ID;
  if (envPerson != null && envPerson !== "") {
    const parsed = Number(envPerson);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return config.personId;
}

// src/domain/catalog-sync.ts
function normalizeBoolean(val) {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    return val === "t" || val === "true" || val === "1";
  }
  return false;
}
function normalizeActive(val) {
  if (val == null) return true;
  return normalizeBoolean(val);
}
function getString(obj, ...keys) {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string") return val;
  }
  return void 0;
}
function getNumber(obj, ...keys) {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const parsed = Number(val);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return void 0;
}
async function syncProjectsCatalog(api, store) {
  const rawClients = await api.listResource("client");
  const rawProjects = await api.listResource("project");
  const rawWorktypes = await api.listResource("projectworktype");
  const rawModules = await api.listResource("projectmodule");
  const clients = rawClients.map((c) => {
    const obj = c;
    return {
      id: getNumber(obj, "id") ?? 0,
      name: getString(obj, "name") ?? "",
      active: normalizeActive(obj.active),
      raw: c
    };
  });
  const projects = rawProjects.map((p) => {
    const obj = p;
    return {
      id: getNumber(obj, "id") ?? 0,
      clientId: getNumber(obj, "clientid", "client_id") ?? void 0,
      name: getString(obj, "name") ?? "",
      active: normalizeActive(obj.active),
      billable: normalizeBoolean(obj.billable),
      raw: p
    };
  });
  const worktypes = rawWorktypes.map((w) => {
    const obj = w;
    return {
      id: getNumber(obj, "id") ?? 0,
      projectId: getNumber(obj, "projectid", "project_id") ?? 0,
      worktypeId: getNumber(obj, "worktypeid", "worktype_id") ?? void 0,
      name: getString(obj, "worktype", "name", "worktypename") ?? "",
      active: normalizeActive(obj.active),
      raw: w
    };
  });
  const modules = rawModules.map((m) => {
    const obj = m;
    return {
      id: getNumber(obj, "id") ?? 0,
      projectId: getNumber(obj, "projectid", "project_id") ?? 0,
      moduleId: getNumber(obj, "moduleid", "module_id") ?? void 0,
      name: getString(obj, "module", "name", "modulename") ?? "",
      active: normalizeActive(obj.active),
      raw: m
    };
  });
  const activeProjects = projects.filter((p) => p.active);
  const activeProjectIds = new Set(activeProjects.map((p) => p.id));
  const referencedClientIds = new Set(
    activeProjects.map((p) => p.clientId).filter((id) => id != null)
  );
  const retainedClients = clients.filter((c) => c.active || referencedClientIds.has(c.id));
  const activeWorktypes = worktypes.filter((w) => w.active && activeProjectIds.has(w.projectId));
  const activeModules = modules.filter((m) => m.active && activeProjectIds.has(m.projectId));
  store.replaceCatalog({
    clients: retainedClients,
    projects: activeProjects,
    worktypes: activeWorktypes,
    modules: activeModules
  });
  return {
    clients: retainedClients.length,
    projects: activeProjects.length,
    worktypes: activeWorktypes.length,
    modules: activeModules.length
  };
}

// src/domain/db.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import { dirname } from "node:path";
var importModule = (specifier) => import(specifier);
async function resolveDatabaseConstructor(importer = importModule) {
  try {
    const nodeSqlite = await importer("node:sqlite");
    if (nodeSqlite.DatabaseSync) return nodeSqlite.DatabaseSync;
  } catch (error) {
    const bunSqlite2 = await importer("bun:sqlite");
    if (bunSqlite2.Database) return bunSqlite2.Database;
    throw error;
  }
  const bunSqlite = await importer("bun:sqlite");
  if (bunSqlite.Database) return bunSqlite.Database;
  throw new Error("No supported SQLite runtime is available");
}
var originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const msg = typeof warning === "string" ? warning : "message" in warning ? warning.message : "";
  if (msg.includes("SQLite is an experimental feature")) return;
  originalEmitWarning.call(process, warning, ...args);
};
var DatabaseSync = await resolveDatabaseConstructor();
var DbCompat = class {
  open = true;
  db;
  constructor(path) {
    this.db = new DatabaseSync(path);
  }
  exec(sql) {
    this.db.exec(sql);
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return new StatementCompat(stmt);
  }
  transaction(fn) {
    return () => {
      this.db.exec("BEGIN");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    };
  }
  close() {
    if (this.open) {
      this.db.close();
      this.open = false;
    }
  }
};
var StatementCompat = class {
  constructor(stmt) {
    this.stmt = stmt;
  }
  stmt;
  get(...params) {
    return this.stmt.get(...params);
  }
  all(...params) {
    return this.stmt.all(...params);
  }
  run(...params) {
    const result = this.stmt.run(...params);
    return {
      lastInsertRowid: Number(result.lastInsertRowid),
      changes: Number(result.changes)
    };
  }
};
function openDatabase(path) {
  mkdirSync2(dirname(path), { recursive: true });
  const db = new DbCompat(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
function migrate(db) {
  db.exec(`
    create table if not exists settings (
      key text primary key,
      value text not null,
      updated_at text not null
    );

    create table if not exists clients (
      id integer primary key,
      name text not null,
      active integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists projects (
      id integer primary key,
      client_id integer,
      name text not null,
      active integer,
      billable integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists project_worktypes (
      id integer primary key,
      project_id integer not null,
      worktype_id integer,
      name text not null,
      active integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists project_modules (
      id integer primary key,
      project_id integer not null,
      module_id integer,
      name text not null,
      active integer,
      raw_json text not null,
      synced_at text not null
    );

    create table if not exists project_defaults (
      project_id integer primary key,
      default_worktype_id integer,
      default_module_id integer,
      updated_at text not null
    );

    create table if not exists timers (
      local_id text primary key,
      project_id integer,
      worktype_id integer,
      module_id integer,
      description text not null,
      notes text,
      started_at text not null,
      stopped_at text,
      elapsed_seconds integer not null default 0,
      state text not null check (state in ('active', 'stopped')),
      created_at text not null,
      updated_at text not null
    );

    create table if not exists time_entries (
      local_id text primary key,
      remote_id integer,
      source_timer_id text,
      project_id integer not null,
      worktype_id integer not null,
      module_id integer,
      date text not null,
      start_at text,
      end_at text,
      duration_seconds integer not null,
      description text,
      billable integer not null default 1,
      sync_status text not null check (sync_status in ('pending', 'synced', 'failed', 'needs_review')),
      sync_attempts integer not null default 0,
      last_sync_error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists idx_timers_state on timers(state);
    create index if not exists idx_time_entries_date on time_entries(date);
    create index if not exists idx_time_entries_project on time_entries(project_id);
    create index if not exists idx_time_entries_sync on time_entries(sync_status);

    create table if not exists sync_lease (
      id integer primary key check (id = 1),
      owner text,
      expires_at integer not null default 0
    );
  `);
  db.exec("insert or ignore into sync_lease (id, owner, expires_at) values (1, null, 0)");
}

// src/domain/intervals-api.ts
var PAGE_SIZE = 100;
var MAX_PAGES = 1e3;
var IntervalsApiClient = class {
  constructor(options) {
    this.options = options;
  }
  options;
  async listResource(resource, query = {}) {
    const items = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const data = await this.request("GET", resource, void 0, {
        ...query,
        limit: String(PAGE_SIZE),
        offset: String(offset)
      });
      const pageItems = extractCollection(data, resource);
      items.push(...pageItems);
      if (pageItems.length < PAGE_SIZE) return items;
    }
    throw new Error(`Exceeded ${MAX_PAGES} pages while fetching ${resource}`);
  }
  async createResource(resource, body) {
    return this.request("POST", resource, body);
  }
  async updateResource(resource, id, body) {
    return this.request("PUT", `${resource}/${id}`, body);
  }
  async deleteResource(resource, id) {
    return this.request("DELETE", `${resource}/${id}`);
  }
  async request(method, resourcePath, body, query) {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`;
    const url = new URL(resourcePath.endsWith("/") ? resourcePath : `${resourcePath}/`, base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    const headers = {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${this.options.apiKey}:X`).toString("base64")}`
    };
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(url.toString(), { method, headers, body: body ? JSON.stringify(body) : void 0 });
    const text = await response.text();
    const data = text ? JSON.parse(text) : void 0;
    if (!response.ok) throw new Error(sanitizeApiError(text || `${response.status} ${response.statusText}`, this.options.apiKey));
    return data;
  }
};
function extractCollection(data, resource) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const object = data;
    for (const key of [resource, `${resource}s`, "items", "data"]) {
      if (Array.isArray(object[key])) return object[key];
    }
  }
  return [];
}
function sanitizeApiError(message, apiKey) {
  let clean = message.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]");
  if (apiKey) clean = clean.split(apiKey).join("[redacted]");
  return clean;
}

// src/domain/project-defaults-store.ts
var ProjectDefaultsStore = class {
  constructor(db) {
    this.db = db;
  }
  db;
  setProjectDefaults(input) {
    this.db.prepare(`
      insert into project_defaults(project_id, default_worktype_id, default_module_id, updated_at)
      values (?, ?, ?, ?)
      on conflict(project_id) do update set
        default_worktype_id = excluded.default_worktype_id,
        default_module_id = excluded.default_module_id,
        updated_at = excluded.updated_at
    `).run(input.projectId, input.defaultWorktypeId ?? null, input.defaultModuleId ?? null, (/* @__PURE__ */ new Date()).toISOString());
  }
  getProjectDefaults(projectId) {
    const row = this.db.prepare("select default_worktype_id as worktypeId, default_module_id as moduleId from project_defaults where project_id = ?").get(projectId);
    if (!row) return void 0;
    return { worktypeId: row.worktypeId ?? void 0, moduleId: row.moduleId ?? void 0 };
  }
  resolveForProject(input) {
    const defaults = this.getProjectDefaults(input.projectId);
    return {
      worktypeId: input.worktypeId ?? defaults?.worktypeId,
      moduleId: input.moduleId ?? defaults?.moduleId
    };
  }
};

// src/domain/sync-lease.ts
var SYNC_LEASE_TTL_MS = 6e4;
function claimSyncLease(db, owner, nowMs, ttlMs = SYNC_LEASE_TTL_MS) {
  const result = db.prepare("update sync_lease set owner = ?, expires_at = ? where id = 1 and (expires_at < ? or owner = ?)").run(owner, nowMs + ttlMs, nowMs, owner);
  return result.changes === 1;
}
function releaseSyncLease(db, owner) {
  db.prepare("update sync_lease set expires_at = 0 where id = 1 and owner = ?").run(owner);
}
async function withSyncLease(db, owner, fn, nowMs = Date.now) {
  if (!claimSyncLease(db, owner, nowMs())) return void 0;
  try {
    return await fn();
  } finally {
    releaseSyncLease(db, owner);
  }
}

// src/domain/duration-rounding.ts
var ROUNDING_SECONDS = 360;
function roundDurationSecondsForIntervals(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.floor(durationSeconds / ROUNDING_SECONDS + 0.5) * ROUNDING_SECONDS;
}

// src/domain/sync-service.ts
async function syncPending(options) {
  const { timeRepo, api, personId, limit = 20, catalog, renewLease } = options;
  const entries = timeRepo.pendingForSync(limit);
  let timeEntriesCreated = 0;
  let timeEntriesUpdated = 0;
  let failed = 0;
  for (const entry of entries) {
    if (renewLease?.() === false) break;
    if (personId == null) {
      timeRepo.markSyncFailed(entry.localId, "Missing personId: set INTERVALS_PERSON_ID or run `intervals setup` to configure your Intervals person ID.");
      failed++;
      continue;
    }
    if (catalog) {
      const validation = validateClassification(catalog, entry.projectId, entry.worktypeId, entry.moduleId);
      if (validation) {
        timeRepo.markSyncFailed(entry.localId, validation);
        failed++;
        continue;
      }
    }
    const durationSeconds = roundDurationSecondsForIntervals(entry.durationSeconds);
    if (durationSeconds !== entry.durationSeconds) {
      timeRepo.setDurationSeconds(entry.localId, durationSeconds);
    }
    const payload = {
      projectid: entry.projectId,
      worktypeid: entry.worktypeId,
      personid: personId,
      date: entry.date,
      time: durationSeconds / 3600,
      description: entry.description ?? "",
      billable: entry.billable ? "t" : "f"
    };
    if (entry.moduleId != null) {
      payload.moduleid = entry.moduleId;
    }
    try {
      if (entry.remoteId == null) {
        const duplicateRemoteId = await findDuplicateRemoteTimeEntry(api, entry, personId, durationSeconds);
        if (duplicateRemoteId != null) {
          timeRepo.setRemoteTime(entry.localId, duplicateRemoteId);
          timeEntriesUpdated++;
          continue;
        }
        const response = await api.createResource("time", payload);
        const remoteId = extractRemoteId(response);
        if (remoteId != null) {
          timeRepo.setRemoteTime(entry.localId, remoteId);
        } else {
          timeRepo.markSyncFailed(entry.localId, "Could not extract remote ID from create response");
          failed++;
          continue;
        }
        timeEntriesCreated++;
      } else {
        await api.updateResource("time", entry.remoteId, payload);
        timeRepo.setRemoteTime(entry.localId, entry.remoteId);
        timeEntriesUpdated++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      timeRepo.markSyncFailed(entry.localId, sanitizeSyncError(message));
      failed++;
    }
  }
  return { timeEntriesCreated, timeEntriesUpdated, failed };
}
async function findDuplicateRemoteTimeEntry(api, entry, personId, durationSeconds) {
  if (!api.listResource) return void 0;
  const remoteEntries = await api.listResource("time", {
    personid: String(personId),
    datebegin: entry.date,
    dateend: entry.date
  });
  for (const remoteEntry of remoteEntries) {
    const remoteId = extractRemoteId(remoteEntry);
    if (remoteId != null && remoteEntryMatches(remoteEntry, entry, personId, durationSeconds)) {
      return remoteId;
    }
  }
  return void 0;
}
function remoteEntryMatches(remoteEntry, entry, personId, durationSeconds) {
  if (!remoteEntry || typeof remoteEntry !== "object") return false;
  const obj = remoteEntry;
  const remotePersonId = numberField(obj, "personid", "person_id");
  if (remotePersonId != null && remotePersonId !== personId) return false;
  return numberField(obj, "projectid", "project_id") === entry.projectId && numberField(obj, "worktypeid", "worktype_id") === entry.worktypeId && optionalNumberField(obj, "moduleid", "module_id") === entry.moduleId && stringField(obj, "date").slice(0, 10) === entry.date && Math.round((numberField(obj, "time") ?? NaN) * 3600) === durationSeconds && stringField(obj, "description") === (entry.description ?? "");
}
function numberField(obj, ...keys) {
  for (const key of keys) {
    const value = toNumber(obj[key]);
    if (value != null) return value;
  }
  return void 0;
}
function optionalNumberField(obj, ...keys) {
  for (const key of keys) {
    if (obj[key] == null || obj[key] === "") continue;
    return toNumber(obj[key]);
  }
  return void 0;
}
function stringField(obj, key) {
  const value = obj[key];
  if (value == null) return "";
  return String(value);
}
function validateClassification(catalog, projectId, worktypeId, moduleId) {
  const matches = catalog.searchProjectContext({ projectId, limit: 1 });
  const project = matches[0];
  if (!project) return void 0;
  const worktypeProblem = invalidClassificationMessage({
    kind: "worktype",
    id: worktypeId,
    valid: project.worktypes.map((w) => ({ globalId: w.worktypeId, rowId: w.id, name: w.name }))
  });
  if (worktypeProblem) return worktypeProblem;
  if (moduleId != null) {
    const moduleProblem = invalidClassificationMessage({
      kind: "module",
      id: moduleId,
      valid: project.modules.map((m) => ({ globalId: m.moduleId, rowId: m.id, name: m.name }))
    });
    if (moduleProblem) return moduleProblem;
  }
  return void 0;
}
function invalidClassificationMessage(params) {
  if (params.valid.length === 0) return void 0;
  if (params.valid.some((entry) => entry.globalId === params.id)) return void 0;
  const rowMatch = params.valid.find((entry) => entry.rowId === params.id);
  if (rowMatch && rowMatch.globalId != null) {
    return `Invalid ${params.kind}_id ${params.id}: that is a local catalog row id. Use the Intervals ${params.kind}_id ${rowMatch.globalId} (${rowMatch.name}) instead.`;
  }
  const options = params.valid.map((entry) => `${entry.globalId ?? entry.rowId} ${entry.name}`).join(", ");
  return `Invalid ${params.kind}_id ${params.id} for this project. Expected one of: ${options}.`;
}
function extractRemoteId(response) {
  if (response == null) return void 0;
  if (typeof response === "object") {
    const obj = response;
    const top = toNumber(obj.id);
    if (top != null) return top;
    const nested = obj.time;
    if (nested != null && typeof nested === "object") {
      const timeObj = nested;
      const nestedId = toNumber(timeObj.id);
      if (nestedId != null) return nestedId;
    }
  }
  return void 0;
}
function toNumber(val) {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const parsed = Number(val);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return void 0;
}
function sanitizeSyncError(message) {
  return message.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]");
}

// src/domain/local-id.ts
import { randomBytes } from "node:crypto";
var SHORT_ID_RE = /^[0-9a-f]{8}$/i;
function isShortLocalId(localId) {
  return SHORT_ID_RE.test(localId);
}
function formatEditableLocalId(localId) {
  return isShortLocalId(localId) ? localId.slice(0, 8) : localId;
}
function createShortLocalId(exists, nextCandidate = () => randomBytes(4).toString("hex")) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = nextCandidate().toLowerCase();
    if (!SHORT_ID_RE.test(candidate)) {
      throw new Error(`short id generator returned invalid id: ${candidate}`);
    }
    if (!exists(candidate)) return candidate;
  }
  throw new Error("could not generate unique short local id");
}

// src/domain/time-entry-store.ts
var selectColumns = `select
  local_id as localId,
  remote_id as remoteId,
  source_timer_id as sourceTimerId,
  project_id as projectId,
  worktype_id as worktypeId,
  module_id as moduleId,
  date,
  start_at as startAt,
  end_at as endAt,
  duration_seconds as durationSeconds,
  description,
  billable,
  sync_status as syncStatus,
  sync_attempts as syncAttempts,
  last_sync_error as lastSyncError,
  created_at as createdAt,
  updated_at as updatedAt
from time_entries`;
var TimeEntryStore = class {
  constructor(db) {
    this.db = db;
  }
  db;
  createLocalId() {
    return createShortLocalId((candidate) => this.getTimeEntry(candidate) != null);
  }
  resolveLocalId(localId) {
    const exact = this.db.prepare("select local_id as localId from time_entries where local_id = ?").get(localId);
    if (exact) return exact.localId;
    if (!/^[0-9a-f]{8}$/i.test(localId)) return void 0;
    const matches = this.db.prepare("select local_id as localId from time_entries where lower(local_id) like lower(?) order by local_id limit 2").all(`${localId}%`);
    if (matches.length === 1) return matches[0].localId;
    if (matches.length > 1) throw new Error(`time entry id is ambiguous: ${localId}`);
    return void 0;
  }
  insertTimeEntry(input) {
    this.db.prepare(
      `insert into time_entries (
        local_id, remote_id, source_timer_id,
        project_id, worktype_id, module_id,
        date, start_at, end_at, duration_seconds,
        description, billable, sync_status,
        sync_attempts, last_sync_error, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.localId,
      input.remoteId ?? null,
      input.sourceTimerId ?? null,
      input.projectId,
      input.worktypeId,
      input.moduleId ?? null,
      input.date,
      input.startAt ?? null,
      input.endAt ?? null,
      input.durationSeconds,
      input.description ?? null,
      input.billable === false ? 0 : 1,
      input.syncStatus ?? "pending",
      0,
      null,
      input.createdAt,
      input.updatedAt
    );
    return this.getTimeEntry(input.localId);
  }
  getTimeEntry(localId) {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) return void 0;
    const row = this.db.prepare(`${selectColumns} where local_id = ?`).get(resolvedLocalId);
    if (!row) return void 0;
    return this.mapRow(row);
  }
  listRecent({ limit = 20 } = {}) {
    const rows = this.db.prepare(`${selectColumns} order by updated_at desc limit ?`).all(limit);
    return rows.map((r) => this.mapRow(r));
  }
  findBySourceTimerId(sourceTimerId) {
    const row = this.db.prepare(`${selectColumns} where source_timer_id = ? order by updated_at desc limit 1`).get(sourceTimerId);
    if (!row) return void 0;
    return this.mapRow(row);
  }
  /**
   * Update duration without changing sync metadata. Used when normalizing
   * already-persisted entries before sending them to Intervals.
   */
  setDurationSeconds(localId, durationSeconds) {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db.prepare("update time_entries set duration_seconds = ?, updated_at = ? where local_id = ?").run(durationSeconds, (/* @__PURE__ */ new Date()).toISOString(), resolvedLocalId);
  }
  updateTimeEntry(localId, patch) {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    const sets = [];
    const params = [];
    if (patch.projectId !== void 0) {
      sets.push("project_id = ?");
      params.push(patch.projectId);
    }
    if (patch.worktypeId !== void 0) {
      sets.push("worktype_id = ?");
      params.push(patch.worktypeId);
    }
    if (patch.moduleId !== void 0) {
      sets.push("module_id = ?");
      params.push(patch.moduleId);
    }
    if (patch.date !== void 0) {
      sets.push("date = ?");
      params.push(patch.date);
    }
    if (patch.startAt !== void 0) {
      sets.push("start_at = ?");
      params.push(patch.startAt);
    }
    if (patch.endAt !== void 0) {
      sets.push("end_at = ?");
      params.push(patch.endAt);
    }
    if (patch.durationSeconds !== void 0) {
      sets.push("duration_seconds = ?");
      params.push(patch.durationSeconds);
    }
    if (patch.description !== void 0) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.billable !== void 0) {
      sets.push("billable = ?");
      params.push(patch.billable ? 1 : 0);
    }
    sets.push("sync_status = 'pending'");
    sets.push("last_sync_error = null");
    const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    sets.push("updated_at = ?");
    params.push(updatedAt);
    params.push(resolvedLocalId);
    this.db.prepare(`update time_entries set ${sets.join(", ")} where local_id = ?`).run(...params);
    const updated = this.getTimeEntry(resolvedLocalId);
    if (!updated) {
      throw new Error(`time entry not found: ${localId}`);
    }
    return updated;
  }
  deleteTimeEntry(localId) {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db.prepare("delete from time_entries where local_id = ?").run(resolvedLocalId);
  }
  queryTime({ startDate, endDate, projectId }) {
    let sql = `${selectColumns} where date between ? and ?`;
    const params = [startDate, endDate];
    if (projectId !== void 0) {
      sql += " and project_id = ?";
      params.push(projectId);
    }
    sql += " order by date desc, updated_at desc";
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => this.mapRow(r));
  }
  pendingForSync(limit = 20) {
    const rows = this.db.prepare(`${selectColumns} where sync_status in ('pending', 'failed') order by updated_at desc limit ?`).all(limit);
    return rows.map((r) => this.mapRow(r));
  }
  setRemoteTime(localId, remoteId) {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db.prepare(
      `update time_entries set remote_id = ?, sync_status = 'synced', sync_attempts = 0, last_sync_error = null, updated_at = ? where local_id = ?`
    ).run(remoteId, (/* @__PURE__ */ new Date()).toISOString(), resolvedLocalId);
  }
  markSyncFailed(localId, error) {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) throw new Error(`time entry not found: ${localId}`);
    this.db.prepare(
      `update time_entries set sync_status = 'failed', sync_attempts = sync_attempts + 1, last_sync_error = ?, updated_at = ? where local_id = ?`
    ).run(error, (/* @__PURE__ */ new Date()).toISOString(), resolvedLocalId);
  }
  mapRow(row) {
    return {
      localId: row.localId,
      remoteId: row.remoteId ?? void 0,
      sourceTimerId: row.sourceTimerId ?? void 0,
      projectId: row.projectId,
      worktypeId: row.worktypeId,
      moduleId: row.moduleId ?? void 0,
      date: row.date,
      startAt: row.startAt ?? void 0,
      endAt: row.endAt ?? void 0,
      durationSeconds: row.durationSeconds,
      description: row.description ?? void 0,
      billable: row.billable === 1,
      syncStatus: row.syncStatus,
      syncAttempts: row.syncAttempts,
      lastSyncError: row.lastSyncError ?? void 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
};

// src/domain/date-ranges.ts
function ymd(date) {
  return date.toISOString().slice(0, 10);
}
function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month, day));
}
function resolveDateRange(input) {
  const now = input.now ?? /* @__PURE__ */ new Date();
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
      endDate: ymd(utcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))
    };
  }
  if (input.range === "last_month") {
    return {
      startDate: ymd(utcDate(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
      endDate: ymd(utcDate(today.getUTCFullYear(), today.getUTCMonth(), 0))
    };
  }
  throw new Error(`Unsupported range: ${input.range}`);
}

// src/domain/time-window.ts
function formatLocalTimeOfDay(value, locale = void 0) {
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
    hour12: false
  }).format(date);
}
function formatTimeEntryWindow(input, locale) {
  if (!input.startAt || !input.endAt) return "";
  return `${formatLocalTimeOfDay(input.startAt, locale)}-${formatLocalTimeOfDay(input.endAt, locale)}`;
}
function parseStrictLocalDate(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`invalid date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (!Number.isFinite(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    throw new Error(`invalid date: ${value}`);
  }
  return { year, month, day };
}
function parseStrictLocalTime(value, label) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${label} must be HH:mm local time`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`${label} must be HH:mm local time`);
  }
  return { hour, minute };
}
function parseLocalStartAt(date, startAt) {
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
function calculateDurationForLocalStopTime(input) {
  if (!input.startAt) throw new Error("start_at is required to calculate duration from stop_time");
  const start = parseLocalStartAt(input.date, input.startAt);
  const { hour, minute } = parseStrictLocalTime(input.stopTime, "stop_time");
  parseStrictLocalDate(input.date);
  const stop = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour, minute, 0, 0);
  if (stop.getTime() < start.getTime()) stop.setDate(stop.getDate() + 1);
  const rawDurationSeconds = Math.floor((stop.getTime() - start.getTime()) / 1e3);
  return {
    endAt: input.stopTime.padStart(5, "0"),
    durationSeconds: Math.round(rawDurationSeconds / 10) * 10,
    rawDurationSeconds
  };
}

// src/domain/time-service.ts
var TimeService = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  addTime(input) {
    const resolved = this.deps.defaultsStore.resolveForProject({
      projectId: input.projectId,
      worktypeId: input.worktypeId,
      moduleId: input.moduleId
    });
    const worktypeId = resolved.worktypeId;
    if (worktypeId == null) {
      throw new Error("worktype is required");
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const projectBillable = this.deps.catalogStore.getProject(input.projectId)?.billable;
    return this.deps.timeEntryStore.insertTimeEntry({
      localId: this.deps.timeEntryStore.createLocalId(),
      projectId: input.projectId,
      worktypeId,
      moduleId: resolved.moduleId,
      date: input.date,
      durationSeconds: roundDurationSecondsForIntervals(input.durationSeconds),
      description: input.description,
      billable: input.billable ?? projectBillable,
      createdAt: now,
      updatedAt: now
    });
  }
  editTime(input) {
    const existing = this.deps.timeEntryStore.getTimeEntry(input.localId);
    if (!existing) {
      throw new Error(`time entry not found: ${input.localId}`);
    }
    if (input.projectId != null && input.projectQuery != null) {
      throw new Error("cannot specify both projectId and projectQuery");
    }
    if (input.stopTime !== void 0 && input.endAt !== void 0) {
      throw new Error("cannot specify both stopTime and endAt");
    }
    if (input.stopTime !== void 0 && input.durationSeconds !== void 0) {
      throw new Error("cannot specify both stopTime and durationSeconds");
    }
    let projectId = existing.projectId;
    if (input.projectQuery != null) {
      const matches = this.deps.catalogStore.searchProjectContext({ query: input.projectQuery, limit: 5 });
      if (matches.length === 0) {
        throw new Error(`no project found for query: ${input.projectQuery}`);
      }
      if (matches.length > 1) {
        throw new Error(`project query is ambiguous: ${input.projectQuery} (${matches.length} matches)`);
      }
      projectId = matches[0].projectId;
    } else if (input.projectId !== void 0) {
      projectId = input.projectId;
    }
    const projectChanged = projectId !== existing.projectId;
    let worktypeId = input.worktypeId;
    if (worktypeId === void 0 && projectChanged) {
      const resolved = this.deps.defaultsStore.resolveForProject({ projectId });
      if (resolved.worktypeId == null) {
        throw new Error("worktype is required");
      }
      worktypeId = resolved.worktypeId;
    }
    let moduleId = input.moduleId;
    if (moduleId === void 0 && projectChanged) {
      const resolved = this.deps.defaultsStore.resolveForProject({ projectId });
      moduleId = resolved.moduleId ?? null;
    }
    let calculatedStop;
    if (input.stopTime !== void 0) {
      calculatedStop = calculateDurationForLocalStopTime({
        date: input.date ?? existing.date,
        startAt: input.startAt === null ? void 0 : input.startAt ?? existing.startAt,
        stopTime: input.stopTime
      });
    }
    const patch = {};
    if (projectChanged) patch.projectId = projectId;
    if (worktypeId !== void 0) patch.worktypeId = worktypeId;
    if (moduleId !== void 0) patch.moduleId = moduleId;
    if (input.date !== void 0) patch.date = input.date;
    if (input.startAt !== void 0) patch.startAt = input.startAt;
    if (calculatedStop) {
      patch.endAt = calculatedStop.endAt;
      patch.durationSeconds = roundDurationSecondsForIntervals(calculatedStop.rawDurationSeconds);
    } else {
      if (input.endAt !== void 0) patch.endAt = input.endAt;
      if (input.durationSeconds !== void 0) patch.durationSeconds = roundDurationSecondsForIntervals(input.durationSeconds);
    }
    if (input.description !== void 0) patch.description = input.description;
    if (input.billable !== void 0) patch.billable = input.billable;
    return this.deps.timeEntryStore.updateTimeEntry(input.localId, patch);
  }
  deleteTime(input) {
    const existing = this.deps.timeEntryStore.getTimeEntry(input.localId);
    if (!existing) {
      throw new Error(`time entry not found: ${input.localId}`);
    }
    this.deps.timeEntryStore.deleteTimeEntry(existing.localId);
    return existing;
  }
  queryTime(input) {
    if (input.projectId != null && input.projectQuery != null) {
      throw new Error("cannot specify both projectId and projectQuery");
    }
    const { startDate, endDate } = resolveDateRange({
      range: input.range,
      start_date: input.start_date,
      end_date: input.end_date,
      now: input.now
    });
    let projectId = input.projectId;
    if (input.projectQuery != null) {
      const matches = this.deps.catalogStore.searchProjectContext({ query: input.projectQuery, limit: 5 });
      if (matches.length === 0) {
        throw new Error(`no project found for query: ${input.projectQuery}`);
      }
      if (matches.length > 1) {
        throw new Error(`project query is ambiguous: ${input.projectQuery} (${matches.length} matches)`);
      }
      projectId = matches[0].projectId;
    }
    const rawEntries = this.deps.timeEntryStore.queryTime({ startDate, endDate, projectId });
    const entries = rawEntries.map((entry) => {
      const project = this.deps.catalogStore.getProject(entry.projectId);
      const worktype = this.deps.catalogStore.getWorktype(entry.projectId, entry.worktypeId);
      const mod = entry.moduleId != null ? this.deps.catalogStore.getModule(entry.projectId, entry.moduleId) : void 0;
      return {
        ...entry,
        projectName: project?.name ?? `Project ${entry.projectId}`,
        worktypeName: worktype?.name ?? `Worktype ${entry.worktypeId}`,
        moduleName: mod?.name
      };
    });
    const projectTotals = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const existing = projectTotals.get(entry.projectId);
      if (existing) {
        existing.totalSeconds += entry.durationSeconds;
      } else {
        projectTotals.set(entry.projectId, {
          projectId: entry.projectId,
          projectName: entry.projectName,
          totalSeconds: entry.durationSeconds
        });
      }
    }
    return {
      startDate,
      endDate,
      totalSeconds: entries.reduce((sum, e) => sum + e.durationSeconds, 0),
      entries,
      byProject: Array.from(projectTotals.values())
    };
  }
};

// src/domain/timer-service.ts
import { randomBytes as randomBytes2 } from "node:crypto";
var TimerService = class {
  constructor(timerStore, timeEntryStore, defaultsStore, catalogStore) {
    this.timerStore = timerStore;
    this.timeEntryStore = timeEntryStore;
    this.defaultsStore = defaultsStore;
    this.catalogStore = catalogStore;
  }
  timerStore;
  timeEntryStore;
  defaultsStore;
  catalogStore;
  startTimer(input) {
    const now = input.now ?? /* @__PURE__ */ new Date();
    const iso = now.toISOString();
    return this.timerStore.insertTimer({
      localId: this.createTimerLocalId(),
      description: input.description,
      projectId: input.projectId,
      worktypeId: input.worktypeId,
      moduleId: input.moduleId,
      notes: input.notes,
      startedAt: iso,
      createdAt: iso,
      updatedAt: iso
    });
  }
  editTimer(input) {
    const timer = this.timerStore.getTimer(input.localId);
    if (!timer) throw new Error(`timer not found: ${input.localId}`);
    if (timer.state !== "active") throw new Error(`timer is not active: ${input.localId}`);
    const projectId = input.projectId ?? timer.projectId;
    const projectChanged = input.projectId != null && input.projectId !== timer.projectId;
    const explicitModule = input.moduleId !== void 0;
    const resolved = projectId != null ? this.defaultsStore.resolveForProject({
      projectId,
      worktypeId: input.worktypeId ?? (projectChanged ? void 0 : timer.worktypeId),
      moduleId: explicitModule ? input.moduleId ?? void 0 : projectChanged ? void 0 : timer.moduleId
    }) : { worktypeId: input.worktypeId ?? timer.worktypeId, moduleId: explicitModule ? input.moduleId ?? void 0 : timer.moduleId };
    return this.timerStore.updateTimer(timer.localId, {
      projectId: input.projectId,
      worktypeId: input.worktypeId !== void 0 || projectChanged ? resolved.worktypeId ?? null : void 0,
      moduleId: explicitModule ? input.moduleId : projectChanged ? resolved.moduleId ?? null : void 0,
      description: input.description,
      updatedAt: (input.now ?? /* @__PURE__ */ new Date()).toISOString()
    });
  }
  deleteTimer(input) {
    const timer = this.timerStore.getTimer(input.localId);
    if (!timer) throw new Error(`timer not found: ${input.localId}`);
    const linkedEntry = this.timeEntryStore.findBySourceTimerId(timer.localId);
    if (timer.state === "stopped" && linkedEntry) {
      throw new Error(`cannot delete stopped timer with linked time entry: ${linkedEntry.localId}`);
    }
    this.timerStore.deleteTimer(timer.localId);
    return timer;
  }
  stopTimer(input) {
    const timer = this.timerStore.getTimer(input.localId);
    if (!timer) throw new Error(`timer not found: ${input.localId}`);
    if (timer.state !== "active") throw new Error(`timer is not active: ${input.localId}`);
    const now = input.now ?? /* @__PURE__ */ new Date();
    const stoppedAt = now.toISOString();
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - new Date(timer.startedAt).getTime()) / 1e3));
    const projectId = input.projectId ?? timer.projectId;
    if (projectId == null) throw new Error("project is required");
    const projectChanged = input.projectId != null && input.projectId !== timer.projectId;
    const resolved = this.defaultsStore.resolveForProject({
      projectId,
      worktypeId: input.worktypeId ?? (projectChanged ? void 0 : timer.worktypeId),
      moduleId: input.moduleId ?? (projectChanged ? void 0 : timer.moduleId)
    });
    const worktypeId = resolved.worktypeId;
    if (worktypeId == null) throw new Error("worktype is required");
    const moduleId = resolved.moduleId;
    const projectBillable = this.catalogStore.getProject(projectId)?.billable;
    return this.timerStore.transaction(() => {
      this.timerStore.markTimerStopped(timer.localId, stoppedAt, elapsedSeconds);
      return this.timeEntryStore.insertTimeEntry({
        localId: this.timeEntryStore.createLocalId(),
        sourceTimerId: timer.localId,
        projectId,
        worktypeId,
        moduleId,
        date: formatLocalDate(new Date(timer.startedAt)),
        startAt: timer.startedAt,
        endAt: stoppedAt,
        durationSeconds: roundDurationSecondsForIntervals(elapsedSeconds),
        description: input.description ?? timer.description,
        billable: input.billable ?? projectBillable,
        createdAt: stoppedAt,
        updatedAt: stoppedAt
      });
    });
  }
  listActive() {
    return this.timerStore.listActive();
  }
  createTimerLocalId() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const localId = randomBytes2(4).toString("hex");
      if (!this.timerStore.getTimer(localId)) return localId;
    }
    throw new Error("could not generate unique timer id");
  }
};
function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// src/domain/timer-store.ts
var TimerStore = class {
  constructor(db) {
    this.db = db;
  }
  db;
  insertTimer(input) {
    this.db.prepare(
      `insert into timers (
        local_id, project_id, worktype_id, module_id,
        description, notes, started_at, stopped_at,
        elapsed_seconds, state, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.localId,
      input.projectId ?? null,
      input.worktypeId ?? null,
      input.moduleId ?? null,
      input.description,
      input.notes ?? null,
      input.startedAt,
      null,
      0,
      "active",
      input.createdAt,
      input.updatedAt
    );
    return this.getTimer(input.localId);
  }
  getTimer(localId) {
    const resolvedLocalId = this.resolveLocalId(localId);
    if (!resolvedLocalId) return void 0;
    const row = this.db.prepare(
      `select
        local_id as localId,
        project_id as projectId,
        worktype_id as worktypeId,
        module_id as moduleId,
        description,
        notes,
        started_at as startedAt,
        stopped_at as stoppedAt,
        elapsed_seconds as elapsedSeconds,
        state,
        created_at as createdAt,
        updated_at as updatedAt
      from timers where local_id = ?`
    ).get(resolvedLocalId);
    if (!row) return void 0;
    return this.mapRow(row);
  }
  listActive() {
    const rows = this.db.prepare(
      `select
        local_id as localId,
        project_id as projectId,
        worktype_id as worktypeId,
        module_id as moduleId,
        description,
        notes,
        started_at as startedAt,
        stopped_at as stoppedAt,
        elapsed_seconds as elapsedSeconds,
        state,
        created_at as createdAt,
        updated_at as updatedAt
      from timers where state = 'active' order by started_at desc`
    ).all();
    return rows.map((r) => this.mapRow(r));
  }
  listRecent(limit = 20) {
    const rows = this.db.prepare(
      `select
        local_id as localId,
        project_id as projectId,
        worktype_id as worktypeId,
        module_id as moduleId,
        description,
        notes,
        started_at as startedAt,
        stopped_at as stoppedAt,
        elapsed_seconds as elapsedSeconds,
        state,
        created_at as createdAt,
        updated_at as updatedAt
      from timers order by updated_at desc limit ?`
    ).all(limit);
    return rows.map((r) => this.mapRow(r));
  }
  updateTimer(localId, patch) {
    const resolvedLocalId = this.resolveLocalId(localId) ?? localId;
    const sets = [];
    const params = [];
    if (patch.projectId !== void 0) {
      sets.push("project_id = ?");
      params.push(patch.projectId);
    }
    if (patch.worktypeId !== void 0) {
      sets.push("worktype_id = ?");
      params.push(patch.worktypeId);
    }
    if (patch.moduleId !== void 0) {
      sets.push("module_id = ?");
      params.push(patch.moduleId);
    }
    if (patch.description !== void 0) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.notes !== void 0) {
      sets.push("notes = ?");
      params.push(patch.notes);
    }
    sets.push("updated_at = ?");
    params.push(patch.updatedAt, resolvedLocalId);
    this.db.prepare(`update timers set ${sets.join(", ")} where local_id = ?`).run(...params);
    const updated = this.getTimer(resolvedLocalId);
    if (!updated) throw new Error(`timer not found: ${localId}`);
    return updated;
  }
  markTimerStopped(localId, stoppedAt, elapsedSeconds) {
    const resolvedLocalId = this.resolveLocalId(localId) ?? localId;
    this.db.prepare(
      `update timers set
        stopped_at = ?,
        elapsed_seconds = ?,
        state = 'stopped',
        updated_at = ?
      where local_id = ?`
    ).run(stoppedAt, elapsedSeconds, stoppedAt, resolvedLocalId);
  }
  deleteTimer(localId) {
    const resolvedLocalId = this.resolveLocalId(localId) ?? localId;
    this.db.prepare("delete from timers where local_id = ?").run(resolvedLocalId);
  }
  transaction(fn) {
    return this.db.transaction(fn)();
  }
  mapRow(row) {
    return {
      localId: row.localId,
      projectId: row.projectId ?? void 0,
      worktypeId: row.worktypeId ?? void 0,
      moduleId: row.moduleId ?? void 0,
      description: row.description,
      notes: row.notes ?? void 0,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt ?? void 0,
      elapsedSeconds: row.elapsedSeconds,
      state: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
  resolveLocalId(localId) {
    const exact = this.db.prepare("select local_id as localId from timers where local_id = ?").get(localId);
    if (exact) return exact.localId;
    if (!/^[0-9a-f]{8}$/i.test(localId)) return void 0;
    const matches = this.db.prepare("select local_id as localId from timers where local_id like ? order by local_id limit 2").all(`${localId}%`);
    if (matches.length === 1) return matches[0].localId;
    if (matches.length > 1) throw new Error(`timer id is ambiguous: ${localId}`);
    return void 0;
  }
};

// src/domain/runtime.ts
var DEFAULT_SYNC_INTERVAL_MS = 10 * 60 * 1e3;
function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const home = getIntervalsHome(env);
  let config = loadConfig(home);
  let credentials = resolveCredentials(config, env);
  let personId = resolvePersonId(config, env);
  const db = openDatabase(databasePath(home));
  const syncOwner = `${process.pid}:${randomUUID()}`;
  const catalogStore = new CatalogStore(db);
  const defaultsStore = new ProjectDefaultsStore(db);
  const timerStore = new TimerStore(db);
  const timeEntryStore = new TimeEntryStore(db);
  let apiClient = credentials ? new IntervalsApiClient({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl }) : void 0;
  const timerService = new TimerService(timerStore, timeEntryStore, defaultsStore, catalogStore);
  const timeService = new TimeService({
    db,
    timeEntryStore,
    catalogStore,
    defaultsStore
  });
  const syncService = {
    syncPending
  };
  async function trySyncNow() {
    if (!apiClient || !personId) {
      return { timeEntriesCreated: 0, timeEntriesUpdated: 0, failed: 0 };
    }
    const result = await withSyncLease(
      db,
      syncOwner,
      () => syncPending({
        timeRepo: timeEntryStore,
        api: apiClient,
        personId,
        limit: 50,
        catalog: catalogStore,
        renewLease: () => claimSyncLease(db, syncOwner, Date.now())
      })
    );
    return result ?? { timeEntriesCreated: 0, timeEntriesUpdated: 0, failed: 0 };
  }
  async function deleteTimeEntry(localId) {
    const entry = timeEntryStore.getTimeEntry(localId);
    if (!entry) throw new Error(`time entry not found: ${localId}`);
    if (entry.remoteId != null) {
      if (!apiClient) {
        throw new Error("cannot delete synced time entry without Intervals credentials configured");
      }
      await apiClient.deleteResource("time", entry.remoteId);
    }
    return timeService.deleteTime({ localId: entry.localId });
  }
  async function syncProjectsCatalogNow() {
    if (!apiClient) {
      throw new Error("Intervals credentials are not configured");
    }
    return syncProjectsCatalog(apiClient, catalogStore);
  }
  let backgroundSync;
  function startBackgroundSyncIfReady() {
    if (backgroundSync) return;
    if (!apiClient || !personId) return;
    const effectiveIntervalMs = options.syncIntervalMs ?? config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    backgroundSync = startBackgroundSync({
      intervalMs: effectiveIntervalMs,
      syncNow: trySyncNow,
      onError: (_error) => {
      }
    });
  }
  function stopBackgroundSync() {
    backgroundSync?.stop();
    backgroundSync = void 0;
  }
  function reloadCredentials() {
    config = loadConfig(home);
    credentials = resolveCredentials(config, env);
    personId = resolvePersonId(config, env);
    apiClient = credentials ? new IntervalsApiClient({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl }) : void 0;
    stopBackgroundSync();
    startBackgroundSyncIfReady();
  }
  function status2() {
    return {
      home,
      credentialsConfigured: credentials != null,
      credentialSource: credentials?.source,
      dbOpen: db.open,
      personId: personId ?? void 0,
      apiClient: apiClient != null,
      backgroundSyncRunning: backgroundSync != null
    };
  }
  function close() {
    stopBackgroundSync();
    if (db.open) {
      releaseSyncLease(db, syncOwner);
      db.close();
    }
  }
  startBackgroundSyncIfReady();
  return {
    status: status2,
    close,
    trySyncNow,
    deleteTimeEntry,
    syncProjectsCatalog: syncProjectsCatalogNow,
    reloadCredentials,
    catalogStore,
    defaultsStore,
    timerStore,
    timeEntryStore,
    timerService,
    timeService,
    syncService
  };
}

// src/domain/format.ts
function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}
function formatTimer(timer, now = /* @__PURE__ */ new Date(), options = {}) {
  return formatTimerRows([timer], now, options)[0] ?? "";
}
function formatTimerRows(timers2, now = /* @__PURE__ */ new Date(), options = {}) {
  return formatTimerRowsInternal(timers2, now, options.bright === true);
}
var ANSI_RESET = "\x1B[0m";
var ANSI_BRIGHT_GREEN = "\x1B[92m";
var ANSI_BRIGHT_YELLOW = "\x1B[93m";
var ANSI_BRIGHT_CYAN = "\x1B[96m";
var ANSI_BRIGHT_RED = "\x1B[91m";
var ANSI_DIM = "\x1B[2m";
function formatTimerRowsByDate(timers2, now = /* @__PURE__ */ new Date(), options = {}) {
  return formatTimerRowsByDateInternal(timers2, now, options.bright === true);
}
var PLAIN_STYLE = {
  cyan: (text) => text,
  yellow: (text) => text,
  green: (text) => text,
  red: (text) => text,
  dim: (text) => text
};
var BRIGHT_STYLE = {
  cyan: (text) => `${ANSI_BRIGHT_CYAN}${text}${ANSI_RESET}`,
  yellow: (text) => `${ANSI_BRIGHT_YELLOW}${text}${ANSI_RESET}`,
  green: (text) => `${ANSI_BRIGHT_GREEN}${text}${ANSI_RESET}`,
  red: (text) => `${ANSI_BRIGHT_RED}${text}${ANSI_RESET}`,
  dim: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`
};
function formatTimerRowsInternal(timers2, now, bright) {
  const parts = timers2.map((timer) => getTimerRowParts(timer, now));
  const statusWidth = Math.max("\u25CF stopped".length, ...parts.map((p) => p.status.length));
  const windowWidth = Math.max("00:00-00:00".length, ...parts.map((p) => p.window.length));
  const durationWidth = Math.max(0, ...parts.map((p) => p.duration.length));
  return parts.map((part) => formatTimerRow(part, { statusWidth, windowWidth, durationWidth }, bright));
}
function formatTimerRowsByDateInternal(timers2, now, bright) {
  const parts = timers2.map((timer) => ({ timer, part: getTimerRowParts(timer, now) }));
  const statusWidth = Math.max("\u25CF stopped".length, ...parts.map((p) => p.part.status.length));
  const windowWidth = Math.max("00:00-00:00".length, ...parts.map((p) => p.part.window.length));
  const durationWidth = Math.max(0, ...parts.map((p) => p.part.duration.length));
  const groups = /* @__PURE__ */ new Map();
  for (const item of parts) {
    const date = getTimerDate(item.timer);
    groups.set(date, [...groups.get(date) ?? [], item]);
  }
  const lines = [];
  for (const [date, group] of groups) {
    if (lines.length > 0) lines.push("");
    const totalSeconds = group.reduce((sum, item) => sum + getTimerElapsedSeconds(item.timer, now), 0);
    lines.push(`${formatTimerDateHeading(date)} \xB7 ${formatDuration(totalSeconds)}`);
    lines.push(...group.map((item) => formatTimerRow(item.part, { statusWidth, windowWidth, durationWidth }, bright)));
  }
  return lines;
}
function getTimerRowParts(timer, now) {
  return {
    id: timer.localId.slice(0, 8),
    state: timer.state,
    status: `\u25CF ${timer.state}`,
    window: getTimerWindow(timer, now),
    duration: formatDuration(getTimerElapsedSeconds(timer, now)),
    description: timer.description
  };
}
function formatTimerRow(part, widths, bright) {
  const statusPadding = " ".repeat(widths.statusWidth - part.status.length);
  const durationPadding = " ".repeat(widths.durationWidth - part.duration.length);
  const statusColor = part.state === "active" ? ANSI_BRIGHT_GREEN : ANSI_DIM;
  const status2 = bright ? `${statusColor}${part.status}${ANSI_RESET}${statusPadding}` : part.status.padEnd(widths.statusWidth);
  const duration = bright ? `${durationPadding}${ANSI_BRIGHT_YELLOW}${part.duration}${ANSI_RESET}` : part.duration.padStart(widths.durationWidth);
  const id = bright ? `${ANSI_BRIGHT_CYAN}${part.id}${ANSI_RESET}` : part.id;
  return `${status2} ${part.window.padEnd(widths.windowWidth)}  ${duration}  ${id}  ${part.description}`;
}
function getTimerWindow(timer, now) {
  const startAt = timer.displayStartAt ?? timer.startedAt;
  const endAt = timer.state === "active" ? timer.displayEndAt ?? now.toISOString() : timer.displayEndAt ?? timer.stoppedAt;
  if (!startAt || !endAt) return "";
  return `${formatLocalTimeOfDay(startAt)}-${formatLocalTimeOfDay(endAt)}`;
}
function getTimerDate(timer) {
  return timer.displayDate ?? formatLocalDate2(timer.startedAt);
}
function formatLocalDate2(value) {
  const date = value ? new Date(value) : void 0;
  if (!date || !Number.isFinite(date.getTime())) return "(unknown date)";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function formatTimerDateHeading(date) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  const localDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][localDate.getDay()];
  return `${weekday} ${date}`;
}
function getTimerElapsedSeconds(timer, now) {
  if (timer.state === "stopped" && timer.displayElapsedSeconds !== void 0) return timer.displayElapsedSeconds;
  if (timer.state !== "active") return timer.elapsedSeconds;
  const startedAt = new Date(timer.startedAt).getTime();
  if (!Number.isFinite(startedAt)) return timer.elapsedSeconds;
  return Math.max(0, Math.floor((now.getTime() - startedAt) / 1e3));
}
function formatTimeEntry(entry) {
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
function formatTimeReport(report, options = {}) {
  const style = options.bright === true ? BRIGHT_STYLE : PLAIN_STYLE;
  const singleDay = report.startDate === report.endDate;
  const period = singleDay ? report.startDate : `${report.startDate} .. ${report.endDate}`;
  const label = options.label ? `${options.label}  ` : "";
  const lines = [
    `${style.cyan(`${label}${period}`)}  ${style.yellow(`Total: ${formatDuration(report.totalSeconds)}`)} ${style.dim(`\xB7 ${report.entries.length} ${pluralize(report.entries.length, "entry", "entries")} \xB7 ${report.byProject.length} ${pluralize(report.byProject.length, "project", "projects")}`)}`
  ];
  for (const group of [...report.byProject].sort((a, b) => b.totalSeconds - a.totalSeconds)) {
    const entries = report.entries.filter((entry) => entry.projectId === group.projectId).sort(compareTimeReportEntries);
    lines.push("");
    lines.push(`${style.green(`\u25CF ${group.projectName}`)}  ${style.yellow(formatDuration(group.totalSeconds))}`);
    const classification = formatSharedClassification(entries);
    if (classification) {
      lines.push(`  ${style.dim(classification)}`);
    }
    for (const entry of entries) {
      lines.push(formatTimeReportEntryRow(entry, style, { includeDate: !singleDay }));
    }
  }
  return lines.join("\n");
}
function compareTimeReportEntries(a, b) {
  return `${a.date} ${a.startAt ?? ""} ${a.createdAt}`.localeCompare(`${b.date} ${b.startAt ?? ""} ${b.createdAt}`);
}
function formatSharedClassification(entries) {
  const labels = new Set(entries.map((entry) => {
    const parts = [entry.moduleName, entry.worktypeName].filter(Boolean);
    return parts.join(" \xB7 ");
  }).filter(Boolean));
  if (labels.size !== 1) return "";
  return [...labels][0];
}
function formatTimeReportEntryRow(entry, style, options) {
  const id = formatEditableLocalId(entry.localId);
  const date = options.includeDate ? `${entry.date} ` : "";
  const window = formatTimeEntryWindow(entry);
  const windowPart = window ? `${window} ` : "";
  const description = entry.description || "(no description)";
  const failedError = entry.syncStatus === "failed" && entry.lastSyncError ? ` (${entry.lastSyncError})` : "";
  return `  ${style.cyan(id)}  ${style.dim(`${date}${windowPart}`)}${style.yellow(formatDuration(entry.durationSeconds))} ${formatSyncStatusSymbol(entry.syncStatus, style)} ${description}${failedError}`;
}
function formatSyncStatusSymbol(status2, style) {
  if (status2 === "synced") return style.green("\u2713");
  if (status2 === "pending") return style.yellow("\u25CF");
  if (status2 === "failed") return style.red("\u2715");
  return style.yellow("!");
}
function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural;
}
function formatSyncSummary(summary) {
  return `created=${summary.timeEntriesCreated} updated=${summary.timeEntriesUpdated} failed=${summary.failed}`;
}

// src/domain/time-edit-feedback.ts
function buildStopTimeEditSummary(input) {
  const startAt = input.startAt === void 0 ? input.existingEntry.startAt : input.startAt ?? void 0;
  const result = calculateDurationForLocalStopTime({
    date: input.date ?? input.existingEntry.date,
    startAt,
    stopTime: input.stopTime
  });
  return {
    start: formatLocalTimeOfDay(startAt),
    end: formatLocalTimeOfDay(result.endAt),
    rawDurationSeconds: result.rawDurationSeconds,
    roundedDurationSeconds: input.roundedDurationSeconds
  };
}
function formatStopTimeEditSummary(summary) {
  return [
    `start: ${summary.start}`,
    `end: ${summary.end}`,
    `raw duration: ${formatDuration(summary.rawDurationSeconds)}`,
    `rounded duration: ${formatDuration(summary.roundedDurationSeconds)}`
  ].join("\n");
}

// src/domain/timer-display.ts
function withLinkedTimeEntryDuration(timeEntryStore, timer) {
  if (timer.state !== "stopped") return timer;
  const entry = timeEntryStore.findBySourceTimerId(timer.localId);
  return entry ? {
    ...timer,
    displayElapsedSeconds: entry.durationSeconds,
    displayDate: entry.date,
    displayStartAt: entry.startAt,
    displayEndAt: entry.endAt
  } : timer;
}

// src/cli/cli.ts
var USAGE = [
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
  "  project-defaults <project_id> <worktype_id> [module_id]   Set project defaults"
].join("\n");
async function runCli(argv, runtime2, io) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return await setup(runtime2, io);
      case "status":
        return status(runtime2, io);
      case "sync-projects":
        return await syncProjects(runtime2, io);
      case "sync-now":
        return await syncNow(runtime2, io);
      case "timers":
        return await timers(runtime2, io, rest);
      case "time":
        return await time(runtime2, io, rest);
      case "project-defaults":
        return projectDefaults(runtime2, io, rest);
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case void 0:
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
async function runCatalogSync(runtime2, io) {
  try {
    const result = await runtime2.syncProjectsCatalog();
    io.out(
      `Project sync complete: ${result.projects} projects, ${result.worktypes} worktypes, ${result.modules} modules, ${result.clients} clients`
    );
    return 0;
  } catch (error) {
    io.err(`Project sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
async function setup(runtime2, io) {
  const current = runtime2.status();
  const home = current.home;
  if (current.credentialSource === "env" || current.credentialSource === "config") {
    const source = current.credentialSource === "env" ? "environment" : "config file";
    io.out(`Intervals credentials loaded from ${source}. Database: ${home}`);
    return runCatalogSync(runtime2, io);
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
  const personId = personIdInput ? Number(personIdInput) : void 0;
  if (personIdInput && !Number.isFinite(personId)) {
    io.err("Setup cancelled: person ID must be a valid number.");
    return 1;
  }
  const config = loadConfig(home);
  saveConfig(home, { ...config, apiKey, personId: personId ?? config.personId });
  io.out(`Credentials saved to ${home}/config.json`);
  runtime2.reloadCredentials();
  return runCatalogSync(runtime2, io);
}
function status(runtime2, io) {
  const current = runtime2.status();
  const activeTimers = runtime2.timerStore.listActive().length;
  const pendingSync = runtime2.timeEntryStore.pendingForSync().length;
  const lastSync = runtime2.catalogStore.getLastProjectSync();
  io.out(
    [
      `Database: ${current.home}`,
      `Credentials: ${current.credentialSource ?? "none"}`,
      `active timers: ${activeTimers}`,
      `pending sync: ${pendingSync}`,
      `last project sync: ${lastSync ?? "never"}`
    ].join(" | ")
  );
  return 0;
}
async function syncProjects(runtime2, io) {
  if (!runtime2.status().credentialsConfigured) {
    io.err("Intervals credentials are not configured. Run `intervals setup` first.");
    return 1;
  }
  return runCatalogSync(runtime2, io);
}
async function syncNow(runtime2, io) {
  const current = runtime2.status();
  if (!current.credentialsConfigured || !current.personId) {
    io.err("Intervals credentials or person ID are not configured. Run `intervals setup` first.");
    return 1;
  }
  const result = await runtime2.trySyncNow();
  io.out(`Sync complete | ${formatSyncSummary(result)}`);
  return 0;
}
async function timers(runtime2, io, rest) {
  const [sub, ...args] = rest;
  if (sub === "edit") {
    const [localId, ...tokens] = args;
    if (!localId) {
      io.err("Usage: intervals timers edit <timer_id> [project_id=...] [worktype_id=...] [module_id=...|null] [description=...]");
      return 2;
    }
    const patch = { localId };
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
    const timer = runtime2.timerService.editTimer(patch);
    io.out("Timer updated");
    io.out(formatTimer(withLinkedTimeEntryDuration(runtime2.timeEntryStore, timer), /* @__PURE__ */ new Date(), { bright: io.bright }));
    return 0;
  }
  if (sub === "delete") {
    const [localId] = args;
    if (!localId) {
      io.err("Usage: intervals timers delete <timer_id>");
      return 2;
    }
    const timer = runtime2.timerService.deleteTimer({ localId });
    io.out("Timer deleted");
    io.out(formatTimer(withLinkedTimeEntryDuration(runtime2.timeEntryStore, timer), /* @__PURE__ */ new Date(), { bright: io.bright }));
    return 0;
  }
  if (sub !== void 0 && sub !== "recent") {
    io.err(`Unknown timers subcommand: ${sub}`);
    return 2;
  }
  const list = sub === "recent" ? runtime2.timerStore.listRecent(10) : runtime2.timerStore.listActive();
  if (list.length === 0) {
    io.out("No timers found.");
    return 0;
  }
  const displayTimers = list.map((t) => withLinkedTimeEntryDuration(runtime2.timeEntryStore, t));
  const lines = sub === "recent" ? formatTimerRowsByDate(displayTimers, /* @__PURE__ */ new Date(), { bright: io.bright }) : formatTimerRows(displayTimers, /* @__PURE__ */ new Date(), { bright: io.bright });
  for (const line of lines) io.out(line);
  return 0;
}
async function time(runtime2, io, rest) {
  if (rest[0] === "edit") {
    const [localId, ...tokens] = rest.slice(1);
    if (!localId) {
      io.err("Usage: intervals time edit <time_entry_id> [field=value ...]. Use stop_time=HH:mm to change the local stop time and recalculate duration.");
      return 2;
    }
    const patch = { localId };
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
    const existingEntry = patch.stopTime ? runtime2.timeEntryStore.getTimeEntry(localId) : void 0;
    const entry = runtime2.timeService.editTime(patch);
    const syncResult = await runtime2.trySyncNow();
    io.out(`Updated ${formatEditableLocalId(entry.localId)}`);
    io.out(
      formatTimeEntry({
        ...entry,
        projectName: runtime2.catalogStore.getProject(entry.projectId)?.name,
        worktypeName: runtime2.catalogStore.getWorktype(entry.projectId, entry.worktypeId)?.name,
        moduleName: entry.moduleId != null ? runtime2.catalogStore.getModule(entry.projectId, entry.moduleId)?.name : void 0
      })
    );
    if (patch.stopTime && existingEntry) {
      io.out(
        formatStopTimeEditSummary(
          buildStopTimeEditSummary({
            existingEntry,
            date: patch.date,
            startAt: patch.startAt,
            stopTime: patch.stopTime,
            roundedDurationSeconds: entry.durationSeconds
          })
        )
      );
    }
    io.out(formatSyncSummary(syncResult));
    return 0;
  }
  let range = "today";
  let startDate;
  let endDate;
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
  const report = runtime2.timeService.queryTime({ range, start_date: startDate, end_date: endDate });
  io.out(formatTimeReport(report, { label: range.replace(/_/g, "-"), bright: io.bright }));
  return 0;
}
function projectDefaults(runtime2, io, rest) {
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
  const moduleId = rest[2] != null ? Number(rest[2]) : void 0;
  if (rest[2] != null && !Number.isFinite(moduleId)) {
    io.err("Invalid module_id: must be a valid number.");
    return 2;
  }
  runtime2.defaultsStore.setProjectDefaults({
    projectId,
    defaultWorktypeId: worktypeId,
    defaultModuleId: moduleId
  });
  io.out(`Project defaults set for ${projectId}: worktype=${worktypeId} module=${moduleId ?? "none"}`);
  return 0;
}

// src/cli/prompt.ts
import { createInterface } from "node:readline";
function promptVisible(question) {
  return new Promise((resolve2) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve2(answer.trim());
    });
  });
}
function promptHidden(question) {
  return new Promise((resolve2) => {
    const input = process.stdin;
    process.stderr.write(`${question} `);
    input.setRawMode?.(true);
    input.resume();
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "") {
          input.setRawMode?.(false);
          input.pause();
          input.off("data", onData);
          process.stderr.write("\n");
          resolve2(value.trim());
          return;
        }
        if (char === "") {
          input.setRawMode?.(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (char === "\x7F" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}

// src/cli/main.ts
var runtime = createRuntime();
try {
  process.exitCode = await runCli(process.argv.slice(2), runtime, {
    out: (line) => process.stdout.write(`${line}
`),
    err: (line) => process.stderr.write(`${line}
`),
    prompt: promptVisible,
    promptSecret: promptHidden,
    interactive: process.stdin.isTTY === true,
    bright: process.stdout.isTTY === true
  });
} finally {
  runtime.close();
}
