import type { Db } from "./db.js";

export const SYNC_LEASE_TTL_MS = 60_000;

export function claimSyncLease(db: Db, owner: string, nowMs: number, ttlMs = SYNC_LEASE_TTL_MS): boolean {
  const result = db
    .prepare("update sync_lease set owner = ?, expires_at = ? where id = 1 and (expires_at < ? or owner = ?)")
    .run(owner, nowMs + ttlMs, nowMs, owner);
  return result.changes === 1;
}

export function releaseSyncLease(db: Db, owner: string): void {
  db.prepare("update sync_lease set expires_at = 0 where id = 1 and owner = ?").run(owner);
}

export async function withSyncLease<T>(
  db: Db,
  owner: string,
  fn: () => Promise<T>,
  nowMs: () => number = Date.now,
): Promise<T | undefined> {
  if (!claimSyncLease(db, owner, nowMs())) return undefined;
  try {
    return await fn();
  } finally {
    releaseSyncLease(db, owner);
  }
}
