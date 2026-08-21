import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_INTERVALS_BASE_URL = "https://api.myintervals.com/";

export interface IntervalsConfig {
  apiKey?: string;
  baseUrl?: string;
  personId?: number;
  syncIntervalMs?: number;
}

export interface ResolvedCredentials {
  apiKey: string;
  baseUrl: string;
  source: "env" | "config";
}

export function getIntervalsHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INTERVALS_HOME || join(homedir(), ".intervals"));
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function databasePath(home: string): string {
  return join(home, "intervals.db");
}

export function ensureIntervalsHome(home: string): void {
  mkdirSync(home, { recursive: true });
}

export function loadConfig(home: string): IntervalsConfig {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as IntervalsConfig;
}

export function saveConfig(home: string, config: IntervalsConfig): void {
  ensureIntervalsHome(home);
  const path = configPath(home);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function resolveCredentials(
  config: IntervalsConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredentials | undefined {
  const envKey = env.INTERVALS_API_KEY;
  if (envKey) {
    return { apiKey: envKey, baseUrl: env.INTERVALS_BASE_URL || config.baseUrl || DEFAULT_INTERVALS_BASE_URL, source: "env" };
  }
  if (config.apiKey) {
    return { apiKey: config.apiKey, baseUrl: config.baseUrl || DEFAULT_INTERVALS_BASE_URL, source: "config" };
  }
  return undefined;
}

export function resolvePersonId(config: IntervalsConfig, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const envPerson = env.INTERVALS_PERSON_ID;
  if (envPerson != null && envPerson !== "") {
    const parsed = Number(envPerson);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return config.personId;
}
