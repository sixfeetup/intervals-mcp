export interface BackgroundSyncHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startBackgroundSync(options: {
  intervalMs: number;
  syncNow: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}): BackgroundSyncHandle {
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
    tick,
  };
}
