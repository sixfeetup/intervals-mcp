import assert from "node:assert/strict";
import test from "node:test";
import type { Runtime } from "../src/domain/runtime.js";
import { createToolDescriptors, type ToolDescriptor } from "../src/tools/index.js";

const EXPECTED_TOOL_NAMES = [
  "find_project_context", "start_timer", "stop_timer", "edit_timer", "delete_timer",
  "add_time", "edit_time", "delete_time", "query_time", "list_timers",
  "lookup_time_entry", "list_time", "set_project_defaults", "sync_now",
];

function descriptorMap(runtime: Runtime): Map<string, ToolDescriptor> {
  return new Map(createToolDescriptors(runtime).map((d) => [d.name, d]));
}

function fakeRuntime() {
  const calls = {
    startTimer: [] as unknown[],
    stopTimer: [] as unknown[],
    addTime: [] as unknown[],
    editTime: [] as unknown[],
    deleteTime: [] as unknown[],
    deleteTimeEntry: [] as unknown[],
    editTimer: [] as unknown[],
    deleteTimer: [] as unknown[],
    trySyncNow: 0,
  };
  const runtime = {
    status: () => ({ credentialsConfigured: false }),
    catalogStore: {
      searchProjectContext: () => [],
      getProject: () => undefined,
      getWorktype: () => undefined,
      getModule: () => undefined,
    },
    defaultsStore: {
      setProjectDefaults: () => {},
    },
    timerService: {
      startTimer: (...args: unknown[]) => {
        calls.startTimer.push(args);
        return { localId: "t1", description: "test", startedAt: "2026-04-24T10:00:00Z", elapsedSeconds: 0, state: "active", createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:00:00Z" };
      },
      stopTimer: (...args: unknown[]) => {
        calls.stopTimer.push(args);
        return { localId: "te1", projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 1800, billable: true, syncStatus: "pending", syncAttempts: 0, createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:00:00Z" };
      },
      editTimer: (...args: unknown[]) => {
        calls.editTimer.push(args);
        return { localId: "t1", description: "test", projectId: 10, worktypeId: 5, moduleId: 7, startedAt: "2026-04-24T10:00:00Z", elapsedSeconds: 0, state: "active", createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:05:00Z" };
      },
      deleteTimer: (...args: unknown[]) => {
        calls.deleteTimer.push(args);
        return { localId: "t1", description: "test", startedAt: "2026-04-24T10:00:00Z", elapsedSeconds: 0, state: "active", createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:00:00Z" };
      },
      listActive: () => [],
    },
    timeService: {
      addTime: (...args: unknown[]) => {
        calls.addTime.push(args);
        return { localId: "te1", projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 3600, billable: true, syncStatus: "pending", syncAttempts: 0, createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:00:00Z" };
      },
      editTime: (...args: unknown[]) => {
        calls.editTime.push(args);
        return { localId: "te1", projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 1800, billable: true, syncStatus: "pending", syncAttempts: 0, createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:00:00Z" };
      },
      deleteTime: (...args: unknown[]) => {
        calls.deleteTime.push(args);
        return { localId: "te1", projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 1800, description: "test entry", billable: true, syncStatus: "pending", syncAttempts: 0, createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:00:00Z" };
      },
      queryTime: () => ({
        startDate: "2026-04-24",
        endDate: "2026-04-24",
        totalSeconds: 0,
        entries: [],
        byProject: [],
      }),
    },
    timerStore: {
      listRecent: () => [],
    },
    timeEntryStore: {
      listRecent: () => [],
      getTimeEntry: () => ({ localId: "te1", date: "2026-04-24", startAt: "07:07" }),
      findBySourceTimerId: () => undefined,
    },
    deleteTimeEntry: async (...args: unknown[]) => {
      calls.deleteTimeEntry.push(args);
      return { localId: "te1", projectId: 10, worktypeId: 5, date: "2026-04-24", durationSeconds: 1800, description: "test entry", billable: true, syncStatus: "pending", syncAttempts: 0, createdAt: "2026-04-24T10:00:00Z", updatedAt: "2026-04-24T10:00:00Z" };
    },
    trySyncNow: async () => {
      calls.trySyncNow += 1;
      return { timeEntriesCreated: 0, timeEntriesUpdated: 0, failed: 0 };
    },
  };
  return { runtime: runtime as unknown as Runtime, calls };
}

test("exposes exactly the 14 renamed tools with object schemas", () => {
  const descriptors = createToolDescriptors(fakeRuntime().runtime);
  assert.deepEqual(descriptors.map((d) => d.name).sort(), [...EXPECTED_TOOL_NAMES].sort());
  for (const d of descriptors) {
    assert.ok(d.title.length > 0, `${d.name} has a title`);
    assert.ok(d.description.length > 0, `${d.name} has a description`);
    assert.equal((d.inputSchema as { type?: string }).type, "object", `${d.name} schema is an object`);
    assert.ok(!d.name.startsWith("intervals_"), `${d.name} carries no intervals_ prefix`);
  }
});

test("safety-critical guidance lives in tool descriptions", () => {
  const tools = descriptorMap(fakeRuntime().runtime);
  assert.match(tools.get("start_timer")!.description, /Never start a timer implicitly/);
  assert.match(tools.get("start_timer")!.description, /list_timers/);
  assert.match(tools.get("edit_time")!.description, /stop_time/);
  assert.match(tools.get("edit_time")!.description, /end_at/);
});

test("query_time uses a string-literal union for range", () => {
  const tools = descriptorMap(fakeRuntime().runtime);
  const schema = tools.get("query_time")!.inputSchema as { properties: { range: unknown } };
  const range = JSON.stringify(schema.properties.range);
  for (const value of ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "custom"]) {
    assert.ok(range.includes(value), `range schema mentions ${value}`);
  }
});

test("lookup_time_entry throws a readable domain error when nothing is linked", async () => {
  const { runtime } = fakeRuntime();
  await assert.rejects(
    descriptorMap(runtime).get("lookup_time_entry")!.execute({ timer_id: "missing" }),
    /no time entry linked to timer: missing/,
  );
});

test("find_project_context returns global Intervals worktype and module IDs", async () => {
  const { runtime } = fakeRuntime();
  (runtime.catalogStore as unknown as { searchProjectContext: (input: unknown) => unknown }).searchProjectContext = () => [
    {
      projectId: 1447065,
      projectName: "Clubhouse Consulting",
      clientName: "Alpha Exploration Co.",
      billable: true,
      worktypes: [
        { id: 32088213, worktypeId: 816862, name: "Consulting", active: true },
      ],
      modules: [
        { id: 22457817, moduleId: 560580, name: "foundations", active: true },
      ],
    },
  ];
  const tool = descriptorMap(runtime).get("find_project_context")!;
  const result = await tool.execute({ query: "Clubhouse" });
  const text = result.text;

  assert.ok(text.includes("816862 Consulting"), `expected global worktype id in output, got: ${text}`);
  assert.ok(text.includes("560580 foundations"), `expected global module id in output, got: ${text}`);
  assert.ok(!text.includes("32088213"), "should not expose local project_worktypes.id");
  assert.ok(!text.includes("22457817"), "should not expose local project_modules.id");
});

test("start_timer requires only description", async () => {
  const { runtime } = fakeRuntime();
  const tool = descriptorMap(runtime).get("start_timer")!;
  const result = await tool.execute({ description: "write tests" });
  assert.ok(result.text.includes("t1"));
});

test("start_timer passes parsed start_at to timer service", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("start_timer")!;

  await tool.execute({ description: "write tests", start_at: "2000-01-01T09:30:00.000Z" });

  const [input] = calls.startTimer[0] as [{ now?: Date }];
  assert.equal(input.now?.toISOString(), "2000-01-01T09:30:00.000Z");
});

test("start_timer rejects invalid start_at", async () => {
  const { runtime } = fakeRuntime();
  const tool = descriptorMap(runtime).get("start_timer")!;

  await assert.rejects(
    tool.execute({ description: "write tests", start_at: "not a time" }),
    /invalid start_at: not a time/,
  );
});

test("start_timer rejects empty start_at", async () => {
  const { runtime } = fakeRuntime();
  const tool = descriptorMap(runtime).get("start_timer")!;

  await assert.rejects(
    tool.execute({ description: "write tests", start_at: "" }),
    /invalid start_at:/,
  );
});

test("stop_timer creates time entry and triggers sync", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("stop_timer")!;
  const result = await tool.execute({ timer_id: "t1", project_id: 10, worktype_id: 5 });
  assert.ok(result.text.includes("te1"));
  assert.equal(calls.trySyncNow, 1, "trySyncNow should be called once");
});

test("edit_timer updates running timer classification", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("edit_timer")!;
  const result = await tool.execute({ timer_id: "t1", project_id: 10, worktype_id: 5, module_id: 7 });
  assert.ok(result.text.includes("t1"));

  const editCall = calls.editTimer[0] as [{ localId?: string; projectId?: number; worktypeId?: number; moduleId?: number }];
  assert.deepEqual(editCall[0], { localId: "t1", projectId: 10, worktypeId: 5, moduleId: 7 });
});

test("edit_timer updates a running timer description", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("edit_timer")!;
  const result = await tool.execute({ timer_id: "t1", description: "Updated timer description" });
  assert.ok(result.text.includes("t1"));

  const editCall = calls.editTimer[0] as [{ localId?: string; description?: string }];
  assert.deepEqual(editCall[0], { localId: "t1", description: "Updated timer description" });
});

test("delete_timer deletes a timer", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("delete_timer")!;
  const result = await tool.execute({ timer_id: "t1" });
  assert.ok(result.text.includes("Timer deleted"));

  const deleteCall = calls.deleteTimer[0] as [{ localId?: string }];
  assert.deepEqual(deleteCall[0], { localId: "t1" });
});

test("list_timers recent uses linked time entry duration for stopped timers", async () => {
  const { runtime } = fakeRuntime();
  (runtime.timerStore as any).listRecent = () => [{
    localId: "t1",
    description: "test timer",
    elapsedSeconds: 29040,
    state: "stopped",
    startedAt: "2026-07-01T09:28:00.000Z",
    createdAt: "2026-07-01T09:28:00.000Z",
    updatedAt: "2026-07-01T17:32:00.000Z",
  }];
  (runtime.timeEntryStore as any).findBySourceTimerId = () => ({ durationSeconds: 25200 });
  const tool = descriptorMap(runtime).get("list_timers")!;

  const result = await tool.execute({ state: "recent" });
  const text = result.text;

  assert.ok(text.includes("7h"), `expected linked entry duration, got: ${text}`);
  assert.ok(!text.includes("8h 4m"), `should not show stale timer duration: ${text}`);
});

test("lookup_time_entry returns the time entry id for a source timer", async () => {
  const { runtime } = fakeRuntime();
  (runtime.timeEntryStore as any).findBySourceTimerId = () => ({ localId: "4ee96f17" });
  const tool = descriptorMap(runtime).get("lookup_time_entry")!;
  const result = await tool.execute({ timer_id: "19ee097c" });
  const text = result.text;

  assert.equal(text.trim(), "time_entry_id: 4ee96f17");
  assert.deepEqual(result.details, { timeEntryId: "4ee96f17", timerId: "19ee097c" });
});

test("lookup_time_entry returns full legacy UUID local ids", async () => {
  const { runtime } = fakeRuntime();
  const localId = "4ee96f17-0374-4d1b-a92a-05956213a007";
  (runtime.timeEntryStore as any).findBySourceTimerId = () => ({ localId });
  const tool = descriptorMap(runtime).get("lookup_time_entry")!;
  const result = await tool.execute({ timer_id: "19ee097c" });
  const text = result.text;

  assert.equal(text.trim(), `time_entry_id: ${localId}`);
  assert.deepEqual(result.details, { timeEntryId: localId, timerId: "19ee097c" });
});

test("delete_time deletes a local time entry", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("delete_time")!;

  const result = await tool.execute({ time_entry_id: "te1" });

  assert.ok(result.text.includes("Time entry deleted"));
  const deleteCall = calls.deleteTimeEntry[0] as [string];
  assert.equal(deleteCall[0], "te1");
});

test("delete_time can delete the entry linked to a timer", async () => {
  const { runtime, calls } = fakeRuntime();
  (runtime.timeEntryStore as any).findBySourceTimerId = () => ({ localId: "from-timer" });
  const tool = descriptorMap(runtime).get("delete_time")!;

  await tool.execute({ timer_id: "timer1" });

  const deleteCall = calls.deleteTimeEntry[0] as [string];
  assert.equal(deleteCall[0], "from-timer");
});

test("delete_time rejects both time_entry_id and timer_id", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("delete_time")!;

  await assert.rejects(
    tool.execute({ time_entry_id: "te1", timer_id: "timer1" }),
    /cannot specify both time_entry_id and timer_id/,
  );
  assert.equal(calls.deleteTimeEntry.length, 0);
});

test("edit_time passes stop_time to service", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("edit_time")!;

  await tool.execute({ time_entry_id: "4ee96f17", stop_time: "08:35" });

  const editCall = calls.editTime[0] as [{ stopTime?: string }];
  assert.equal(editCall[0].stopTime, "08:35");
});

test("edit_time with stop_time returns timing summary lines", async () => {
  const { runtime } = fakeRuntime();
  (runtime.timeEntryStore as any).getTimeEntry = () => ({
    localId: "4ee96f17",
    date: "2026-05-05",
    startAt: "07:07",
  });
  (runtime.timeService as any).editTime = () => ({
    localId: "4ee96f17",
    projectId: 10,
    worktypeId: 5,
    date: "2026-05-05",
    startAt: "07:07",
    endAt: "08:35",
    durationSeconds: 5400,
    billable: true,
    syncStatus: "pending",
    syncAttempts: 0,
    createdAt: "2026-05-05T07:07:00.000Z",
    updatedAt: "2026-05-05T08:35:00.000Z",
  });
  const tool = descriptorMap(runtime).get("edit_time")!;

  const result = await tool.execute({ time_entry_id: "4ee96f17", stop_time: "08:35" });
  const text = result.text;

  assert.match(text, /start:/);
  assert.match(text, /end:/);
  assert.match(text, /raw duration:/);
  assert.match(text, /rounded duration:/);
});

test("edit_time rejects both time_entry_id and timer_id", async () => {
  const { runtime, calls } = fakeRuntime();
  (runtime.timeEntryStore as any).findBySourceTimerId = () => ({ localId: "from-timer" });
  const tool = descriptorMap(runtime).get("edit_time")!;

  await assert.rejects(
    tool.execute({ time_entry_id: "te1", timer_id: "t1" }),
    /cannot specify both time_entry_id and timer_id/,
  );
  assert.equal(calls.editTime.length, 0);
});

test("edit_time rejects timer_id when no linked entry exists", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("edit_time")!;

  await assert.rejects(
    tool.execute({ timer_id: "t1" }),
    /no time entry linked to timer: t1/,
  );
  assert.equal(calls.editTime.length, 0);
});

test("edit_time converts duration_minutes to seconds and triggers sync", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("edit_time")!;
  const result = await tool.execute({ time_entry_id: "te1", duration_minutes: 30 });
  assert.ok(result.text.includes("te1"));
  assert.equal(calls.trySyncNow, 1, "trySyncNow should be called once");

  const editCall = calls.editTime[0] as [{ durationSeconds?: number }];
  assert.equal(editCall[0].durationSeconds, 1800, "duration_minutes should be converted to seconds");
});

test("add_time converts duration_minutes to seconds", async () => {
  const { runtime, calls } = fakeRuntime();
  const tool = descriptorMap(runtime).get("add_time")!;
  const result = await tool.execute({ project_id: 10, date: "2026-04-24", duration_minutes: 60 });
  assert.ok(result.text.includes("te1"));

  const addCall = calls.addTime[0] as [{ durationSeconds?: number }];
  assert.equal(addCall[0].durationSeconds, 3600, "duration_minutes should be converted to seconds");
});
