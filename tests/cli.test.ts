import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Runtime } from "../src/domain/runtime.js";
import { runCli, type CliIo } from "../src/cli/cli.js";

function fakeIo(options: { inputs?: string[]; interactive?: boolean } = {}): {
  io: CliIo;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  let inputIndex = 0;
  const inputs = options.inputs ?? [];
  const nextInput = async () => inputs[inputIndex++] ?? "";
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      prompt: nextInput,
      promptSecret: nextInput,
      interactive: options.interactive ?? true,
      bright: false,
    },
    out,
    err,
  };
}

function fakeRuntime(
  options: {
    credentialsConfigured?: boolean;
    personId?: number;
    credentialSource?: "env" | "config";
    home?: string;
    timers?: unknown[];
  } = {},
): {
  runtime: Runtime;
  calls: Record<string, number>;
  lastEditPatch: Record<string, unknown>[];
  lastTimerEditPatch: Record<string, unknown>[];
  queryTimeArgs: unknown[];
} {
  const calls = {
    status: 0,
    trySyncNow: 0,
    syncProjectsCatalog: 0,
    queryTime: 0,
    editTime: 0,
    setProjectDefaults: 0,
    reloadCredentials: 0,
    editTimer: 0,
    deleteTimer: 0,
  };

  const lastEditPatch: Record<string, unknown>[] = [];
  const lastTimerEditPatch: Record<string, unknown>[] = [];
  const queryTimeArgs: unknown[] = [];

  const credentialsConfigured = options.credentialsConfigured ?? true;
  const personId = options.personId ?? 42;
  const credentialSource = options.credentialSource ?? (credentialsConfigured ? "env" : undefined);
  const home = options.home ?? "/tmp/intervals";
  const timers = options.timers ?? [{ localId: "t1", description: "test timer", elapsedSeconds: 120, state: "active" }];

  const runtime = {
    status: () => {
      calls.status++;
      return { home, credentialsConfigured, credentialSource, dbOpen: true, personId, apiClient: credentialsConfigured };
    },
    trySyncNow: async () => {
      calls.trySyncNow++;
      return { timeEntriesCreated: 1, timeEntriesUpdated: 0, failed: 0 };
    },
    syncProjectsCatalog: async () => {
      calls.syncProjectsCatalog++;
      return { clients: 2, projects: 5, worktypes: 8, modules: 3 };
    },
    reloadCredentials: () => {
      calls.reloadCredentials++;
    },
    catalogStore: {
      searchProjectContext: () => [],
      getLastProjectSync: () => "2026-04-24T10:00:00.000Z",
      getProject: () => undefined,
      getWorktype: () => undefined,
      getModule: () => undefined,
    },
    timerStore: {
      listActive: () => timers,
      listRecent: () => [{ localId: "t1", description: "test timer", elapsedSeconds: 120, state: "stopped" }],
    },
    timeEntryStore: {
      pendingForSync: () => [{ localId: "te1" }],
      listRecent: () => [{ localId: "te1", durationSeconds: 3600 }],
      getTimeEntry: () => ({ localId: "te1", date: "2026-05-05", startAt: "07:07", durationSeconds: 3600, syncStatus: "pending" }),
      updateTimeEntry: () => ({ localId: "te1", durationSeconds: 3600, syncStatus: "pending" }),
      findBySourceTimerId: () => undefined,
    },
    timeService: {
      queryTime: (args: unknown) => {
        calls.queryTime++;
        queryTimeArgs.push(args);
        return { startDate: "2026-04-24", endDate: "2026-04-24", totalSeconds: 3600, entries: [], byProject: [] };
      },
      editTime: (patch: Record<string, unknown>) => {
        calls.editTime++;
        lastEditPatch.push(patch);
        return { localId: "te1", syncStatus: "pending" };
      },
    },
    defaultsStore: {
      setProjectDefaults: () => {
        calls.setProjectDefaults++;
      },
    },
    timerService: {
      startTimer: () => ({ localId: "t1", description: "test" }),
      stopTimer: () => ({ localId: "te1", durationSeconds: 1800 }),
      editTimer: (patch: Record<string, unknown>) => {
        calls.editTimer++;
        lastTimerEditPatch.push(patch);
        return { localId: "t1", description: "test timer", elapsedSeconds: 120, state: "active" };
      },
      deleteTimer: () => {
        calls.deleteTimer++;
        return { localId: "t1", description: "test timer", elapsedSeconds: 120, state: "active" };
      },
    },
  } as unknown as Runtime;

  return { runtime, calls, lastEditPatch, lastTimerEditPatch, queryTimeArgs };
}

test("status reports database, credentials, timers, and sync info on one line", async () => {
  const { runtime } = fakeRuntime();
  const { io, out, err } = fakeIo();
  const code = await runCli(["status"], runtime, io);
  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.match(out[0], /Database:.*Credentials:.*active timers:.*pending sync:.*last project sync:/);
  assert.equal(out[0].split(" | ").length, 5);
  assert.equal(err.length, 0);
});

test("sync-now without credentials fails with a setup hint", async () => {
  const { runtime } = fakeRuntime({ credentialsConfigured: false });
  const { io, err } = fakeIo();
  const code = await runCli(["sync-now"], runtime, io);
  assert.equal(code, 1);
  assert.ok(err.some((line) => line.includes("intervals setup")));
});

test("sync-now with credentials succeeds", async () => {
  const { runtime, calls } = fakeRuntime();
  const { io, out } = fakeIo();
  const code = await runCli(["sync-now"], runtime, io);
  assert.equal(code, 0);
  assert.match(out[0], /^Sync complete \| created=/);
  assert.equal(calls.trySyncNow, 1);
});

test("sync-projects requires credentials, then succeeds once configured", async () => {
  const unconfigured = fakeRuntime({ credentialsConfigured: false });
  const unconfiguredIo = fakeIo();
  const failCode = await runCli(["sync-projects"], unconfigured.runtime, unconfiguredIo.io);
  assert.equal(failCode, 1);

  const configured = fakeRuntime();
  const configuredIo = fakeIo();
  const okCode = await runCli(["sync-projects"], configured.runtime, configuredIo.io);
  assert.equal(okCode, 0);
  assert.match(configuredIo.out[0], /^Project sync complete:/);
  assert.equal(configured.calls.syncProjectsCatalog, 1);
});

test("timers with none active reports no timers", async () => {
  const { runtime } = fakeRuntime({ timers: [] });
  const { io, out } = fakeIo();
  const code = await runCli(["timers"], runtime, io);
  assert.equal(code, 0);
  assert.equal(out[0], "No timers found.");
});

test("timers edit without a timer id is a usage error", async () => {
  const { runtime } = fakeRuntime();
  const { io, err } = fakeIo();
  const code = await runCli(["timers", "edit"], runtime, io);
  assert.equal(code, 2);
  assert.ok(err.some((line) => line.startsWith("Usage: intervals timers edit")));
});

test("timers edit rejects a non-numeric project_id", async () => {
  const { runtime } = fakeRuntime();
  const { io, err } = fakeIo();
  const code = await runCli(["timers", "edit", "t1", "project_id=abc"], runtime, io);
  assert.equal(code, 2);
  assert.ok(err.some((line) => line.includes("Invalid numeric value for project_id")));
});

test("timers edit builds a patch with numeric and null fields", async () => {
  const { runtime, lastTimerEditPatch } = fakeRuntime();
  const { io } = fakeIo();
  const code = await runCli(["timers", "edit", "t1", "project_id=5", "module_id=null"], runtime, io);
  assert.equal(code, 0);
  assert.deepEqual(lastTimerEditPatch[0], { localId: "t1", projectId: 5, moduleId: null });
});

test("timers delete removes a timer", async () => {
  const { runtime, calls } = fakeRuntime();
  const { io } = fakeIo();
  const code = await runCli(["timers", "delete", "t1"], runtime, io);
  assert.equal(code, 0);
  assert.equal(calls.deleteTimer, 1);
});

test("time with no args queries today's range", async () => {
  const { runtime, queryTimeArgs } = fakeRuntime();
  const { io } = fakeIo();
  const code = await runCli(["time"], runtime, io);
  assert.equal(code, 0);
  assert.equal((queryTimeArgs[0] as { range: string }).range, "today");
});

test("time with a custom range passes start and end dates", async () => {
  const { runtime, queryTimeArgs } = fakeRuntime();
  const { io } = fakeIo();
  const code = await runCli(["time", "2026-08-01..2026-08-15"], runtime, io);
  assert.equal(code, 0);
  const args = queryTimeArgs[0] as { range: string; start_date?: string; end_date?: string };
  assert.equal(args.range, "custom");
  assert.equal(args.start_date, "2026-08-01");
  assert.equal(args.end_date, "2026-08-15");
});

test("time rejects an unknown range", async () => {
  const { runtime } = fakeRuntime();
  const { io, err } = fakeIo();
  const code = await runCli(["time", "bogus"], runtime, io);
  assert.equal(code, 2);
  assert.ok(err[0].startsWith("Unknown range: bogus"));
});

test("time edit updates duration and reports a sync summary", async () => {
  const { runtime, lastEditPatch } = fakeRuntime();
  const { io, out } = fakeIo();
  const code = await runCli(["time", "edit", "te1", "duration_minutes=90"], runtime, io);
  assert.equal(code, 0);
  assert.equal(lastEditPatch[0].durationSeconds, 5400);
  assert.ok(out.some((line) => line.includes("Updated")));
  assert.ok(out.some((line) => /^created=/.test(line)));
});

test("project-defaults sets defaults for a project", async () => {
  const { runtime, calls } = fakeRuntime();
  const { io, out } = fakeIo();
  const code = await runCli(["project-defaults", "10", "5", "7"], runtime, io);
  assert.equal(code, 0);
  assert.equal(calls.setProjectDefaults, 1);
  assert.equal(out[0], "Project defaults set for 10: worktype=5 module=7");
});

test("project-defaults requires project_id and worktype_id", async () => {
  const { runtime } = fakeRuntime();
  const { io, err } = fakeIo();
  const code = await runCli(["project-defaults", "10"], runtime, io);
  assert.equal(code, 2);
  assert.ok(err.length > 0);
});

test("setup with env credentials reports the source and syncs the catalog", async () => {
  const { runtime, calls } = fakeRuntime({ credentialSource: "env" });
  const { io, out } = fakeIo();
  const code = await runCli(["setup"], runtime, io);
  assert.equal(code, 0);
  assert.ok(out.some((line) => line.includes("environment")));
  assert.equal(calls.syncProjectsCatalog, 1);
});

test("setup without credentials in a non-interactive shell fails", async () => {
  const { runtime } = fakeRuntime({ credentialsConfigured: false });
  const { io, err } = fakeIo({ interactive: false });
  const code = await runCli(["setup"], runtime, io);
  assert.equal(code, 1);
  assert.ok(err.some((line) => line.includes("INTERVALS_API_KEY")));
});

test("interactive setup writes config.json with mode 0600", async () => {
  const home = mkdtempSync(join(tmpdir(), "intervals-cli-"));
  try {
    const { runtime, calls } = fakeRuntime({ credentialsConfigured: false, home });
    const { io } = fakeIo({ inputs: ["secret-key", "42"] });
    const code = await runCli(["setup"], runtime, io);
    assert.equal(code, 0);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(config.apiKey, "secret-key");
    assert.equal(config.personId, 42);
    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
    assert.equal(calls.reloadCredentials, 1);
    assert.equal(calls.syncProjectsCatalog, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown command is a usage error", async () => {
  const { runtime } = fakeRuntime();
  const { io, err } = fakeIo();
  const code = await runCli(["frobnicate"], runtime, io);
  assert.equal(code, 2);
  assert.equal(err[0], "Unknown command: frobnicate");
});

test("no command and help command both show usage on the right stream", async () => {
  const { runtime } = fakeRuntime();

  const noArgsIo = fakeIo();
  const noArgsCode = await runCli([], runtime, noArgsIo.io);
  assert.equal(noArgsCode, 2);
  assert.ok(noArgsIo.err.some((line) => line.includes("Usage: intervals <command>")));
  assert.equal(noArgsIo.out.length, 0);

  const helpIo = fakeIo();
  const helpCode = await runCli(["help"], runtime, helpIo.io);
  assert.equal(helpCode, 0);
  assert.ok(helpIo.out.some((line) => line.includes("Usage: intervals <command>")));
  assert.equal(helpIo.err.length, 0);
});
