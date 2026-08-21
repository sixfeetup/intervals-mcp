# intervals-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `intervals-mcp` — a standalone stdio MCP server for local-first Intervals time tracking, plus a full CLI and a Claude Code plugin packaging both — by porting the pi-free domain layer out of the `pi-intervals` extension.

**Architecture:** Three layers: a domain layer moved verbatim from `pi-intervals` (SQLite stores, services, sync, formatters), a host-agnostic tool-descriptor registry (14 tools), and two thin adapters (MCP stdio server, argv CLI). Distribution is a committed esbuild bundle with zero runtime dependencies, wrapped in a Claude Code plugin with a rewritten guidance skill and CLI-backed slash commands.

**Tech Stack:** TypeScript (strict, NodeNext, ES2022), Node >= 22.5 (`node:sqlite`), typebox (JSON Schema), `@modelcontextprotocol/sdk` (build-time), esbuild, `tsx --test` (node test runner).

**Spec:** `docs/superpowers/specs/2026-08-20-intervals-mcp-design.md` (approved).
**Source material (READ-ONLY reference, never modified):** `/home/roche/projects/pi/extensions/pi-intervals` — referred to as `$SRC` throughout. Set it once per shell:

```bash
SRC=/home/roche/projects/pi/extensions/pi-intervals
```

## Global Constraints

Every task's requirements implicitly include these (all from the spec):

- ESM: `"type": "module"`; TypeScript `strict: true`; `module` and `moduleResolution` both `NodeNext`; target `ES2022`; relative imports carry the `.js` extension.
- Node engine `>= 22.5.0` (required for `node:sqlite`; Bun works via the existing `bun:sqlite` fallback in `db.ts`).
- **Zero runtime dependencies.** `@modelcontextprotocol/sdk`, `typebox`, and `esbuild` are devDependencies only; esbuild bundles the first two into `dist/`. `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` must never be added.
- Indentation: 2 spaces everywhere, including code ported from `$SRC/src/tools.ts` (which uses tabs — do not carry the tabs over).
- **stdio hygiene:** nothing in `src/` may call `console.*` (the CLI writes with `process.stdout.write` / `process.stderr.write`). Only MCP frames may reach the MCP server's stdout; all diagnostics go to stderr.
- Storage: `INTERVALS_HOME` env var if set, else `~/.intervals/`. Credential precedence: `INTERVALS_API_KEY` / `INTERVALS_BASE_URL` / `INTERVALS_PERSON_ID` env vars first, then `config.json` (mode 0600).
- Naming: npm package `intervals-mcp`; Claude Code plugin `intervals`; MCP server key `intervals`; tool names **without** the `intervals_` prefix (14 tools: `find_project_context`, `start_timer`, `stop_timer`, `edit_timer`, `delete_timer`, `add_time`, `edit_time`, `delete_time`, `query_time`, `list_timers`, `lookup_time_entry`, `list_time`, `set_project_defaults`, `sync_now`).
- `dist/` is **committed** and must be rebuilt in the same commit as any `src/` change from Task 5 onward (the Task 9 freshness gate enforces this).
- No pi coupling: `npm run check` (Task 9) greps `src/` for `PI_INTERVALS_HOME`, `.pi/`, `/intervals-`, and `@mariozechner` — user-facing strings must say `intervals setup`, never `/intervals-setup`.
- Every commit leaves `npm run typecheck` and `npm test` green.

## Findings from planning (spec amended 2026-08-21 to incorporate all of these)

Discovered by verifying the spec against `$SRC` on 2026-08-21. The spec has been amended
to match, so plan and spec now agree; the findings stay here because tasks reference them
and they explain choices an implementer might otherwise second-guess.

1. **Test counts.** `$SRC/tests/` holds **21** files (the spec originally said 24). Excluding `tools.test.ts` and `commands.test.ts` (rewritten) and `smoke.test.ts` (it only asserts the pi extension entry point exports a function — superseded by the MCP protocol smoke test), **18** domain test files move across.
2. **`formatTimeReport` is not plain.** The spec originally assumed the non-`Bright` formatters were ANSI-free, but `formatTimeReport` (used by the `query_time` tool) embeds ANSI codes directly. Task 3 therefore makes all formatters plain-by-default with an opt-in `{ bright: true }` option, and the `formatBright*` exports are deleted rather than moved — the CLI passes `{ bright: process.stdout.isTTY === true }` at its call sites. One mechanism instead of two export families, same intent: MCP output is ANSI-free, CLI color appears only on a TTY.
3. **Lease semantics.** The spec's original "TTL is 60s, renewed on each tick, released on shutdown" could not mean a long-held process lease: the default tick is 10 minutes, which cannot sustain a 60s TTL, and it would block another session's manual `sync_now` for minutes. The pinned-down semantics (now in the spec): **claim per sync pass, release in a `finally` after the pass**, plus an owner-guarded release on shutdown as a backstop. The claim SQL's `OR owner = ?` clause is the renewal path (a holder re-claims its own lease). Expiry (60s) covers crashed holders mid-pass.
4. **`command-args.ts` is dropped, not moved.** `splitCommandArgs` existed only because pi handed commands a single raw string. The CLI receives `process.argv`, already tokenized by the shell, so the file would be dead code with no test (there is no `command-args.test.ts`; it was covered via `commands.test.ts`). Nothing imports it after the port.
5. **Two install-time behaviors need verification at Task 8** (now spec assumptions 4 and 5, fallbacks decided): (a) plugin-provided MCP tools surface as `mcp__intervals__<tool>` — verify at install; if the plugin name is prefixed differently, update the skill's tool names to match reality. (b) `` !`command` `` injection and `$ARGUMENTS` work inside plugin `skills/*/SKILL.md` — if not, move the seven slash commands to `commands/*.md` files (classic command files support both).

## File structure (final)

```
intervals-mcp/
├── .claude-plugin/
│   ├── plugin.json               # Task 8
│   └── marketplace.json          # Task 8
├── .mcp.json                     # Task 8
├── .gitignore                    # Task 1
├── LICENSE                       # Task 1 (MIT, copied from $SRC)
├── README.md                     # Task 8
├── package.json                  # Task 1
├── tsconfig.json                 # Task 1
├── bin/intervals                 # Task 7 (CLI shim)
├── dist/                         # Task 5, 7 (committed bundles)
│   ├── server.mjs
│   └── cli.mjs
├── scripts/
│   ├── build.sh                  # Task 5
│   └── check.sh                  # Task 9
├── src/
│   ├── domain/                   # Task 2: 21 files moved from $SRC/src
│   │   ├── ... (see Task 2 list)
│   │   ├── timer-display.ts      # Task 4 (new: shared withLinkedTimeEntryDuration)
│   │   └── sync-lease.ts         # Task 6 (new)
│   ├── tools/index.ts            # Task 4: 14 host-agnostic descriptors
│   ├── mcp/server.ts             # Task 5: stdio adapter
│   └── cli/
│       ├── main.ts               # Task 7: bundled entry
│       ├── cli.ts                # Task 7: runCli + 7 commands
│       └── prompt.ts             # Task 7: readline, hidden input
├── skills/
│   ├── intervals-time-entries/SKILL.md   # Task 8 (rewritten guidance skill)
│   └── intervals-{setup,status,sync-projects,sync-now,timers,time,project-defaults}/SKILL.md  # Task 8
└── tests/
    ├── (18 moved domain test files)      # Task 2
    ├── tools.test.ts             # Task 4 (rewritten against descriptors)
    ├── mcp-server.test.ts        # Task 5 (protocol smoke test)
    ├── sync-lease.test.ts        # Task 6
    └── cli.test.ts               # Task 7
```

---

### Task 1: Scaffold the repo

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `tests/scaffold.test.ts` (temporary, deleted in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run typecheck` and `npm test` runnable and green; devDependencies installed (`typescript`, `tsx`, `@types/node`, and exact-pinned `esbuild`, `@modelcontextprotocol/sdk`, `typebox`).

- [ ] **Step 1: Verify the toolchain**

```bash
node --version    # must print >= v22.5.0
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "intervals-mcp",
  "private": true,
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "engines": {
    "node": ">=22.5.0"
  },
  "scripts": {
    "test": "tsx --test tests/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "build": "./scripts/build.sh",
    "check": "./scripts/check.sh"
  }
}
```

(`bin` is added in Task 7; `build`/`check` scripts exist from Tasks 5/9 — the entries are inert until then.)

- [ ] **Step 3: Write `tsconfig.json`** (identical to `$SRC/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: Write `.gitignore`** (note: `dist/` is NOT ignored — it is committed)

```
node_modules/
*.tsbuildinfo
```

- [ ] **Step 5: Copy the license**

```bash
cp "$SRC/LICENSE" LICENSE
```

- [ ] **Step 6: Install devDependencies**

Exact-pin (`-E`) everything whose bytes end up in the committed bundle or produce it, so the Task 9 freshness diff is deterministic across machines:

```bash
npm install -D -E esbuild @modelcontextprotocol/sdk typebox
npm install -D typescript tsx "@types/node@^22.15.0"
```

- [ ] **Step 7: Write the temporary `tests/scaffold.test.ts`** (gives tsc an input file and proves the runner; deleted in Task 2)

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("test runner works", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 8: Run typecheck and tests**

```bash
npm run typecheck && npm test
```

Expected: typecheck exits 0; test output ends with `pass 1` / `fail 0`.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore LICENSE tests/scaffold.test.ts
git commit -m "chore: scaffold intervals-mcp (ESM, strict TS, node:test via tsx)"
```

---

### Task 2: Move the domain layer and its tests to green

Everything here is a **mechanical move** from the read-only `$SRC` — copy, then apply only the edits listed. Green tests are the proof the move was faithful.

**Files:**
- Create: `src/domain/<21 files>.ts` (copied), `tests/<18 files>.test.ts` (copied)
- Modify (after copy): `src/domain/config.ts`, `src/domain/sync-service.ts`, all copied test files (import paths), `tests/config.test.ts` + `tests/runtime.test.ts` (env var rename)
- Delete: `tests/scaffold.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces: the full domain API under `src/domain/`, unchanged from `$SRC` except storage naming. Key exports later tasks rely on:
  - `createRuntime(options?: { env?: NodeJS.ProcessEnv; syncIntervalMs?: number }): Runtime` and `interface Runtime` (`status()`, `close()`, `trySyncNow()`, `deleteTimeEntry(localId)`, `syncProjectsCatalog()`, `reloadCredentials()`, `catalogStore`, `defaultsStore`, `timerStore`, `timeEntryStore`, `timerService`, `timeService`) from `src/domain/runtime.js`
  - `getIntervalsHome(env?)`, `loadConfig(home)`, `saveConfig(home, config)` from `src/domain/config.js`
  - `openDatabase(path): Db`, `migrate(db)`, `interface Db` from `src/domain/db.js`
  - formatters from `src/domain/format.js` (reshaped in Task 3)

- [ ] **Step 1: Copy the 21 domain source files**

```bash
mkdir -p src/domain
for f in background-sync catalog-store catalog-sync config date-ranges db \
         duration-rounding format intervals-api local-id project-defaults-store \
         runtime start-at sync-service time-edit-feedback time-entry-store \
         time-service time-window timer-service timer-store types; do
  cp "$SRC/src/$f.ts" src/domain/
done
ls src/domain | wc -l   # expected: 21
```

Not copied (and why): `index.ts`, `tools.ts`, `commands.ts` (pi adapters, replaced by Tasks 4/5/7), `quiet-tool-rendering.ts` (pi TUI renderer, dropped), `command-args.ts` (dropped — see Findings #4).

- [ ] **Step 2: De-pi `src/domain/config.ts`**

Replace (at what was `$SRC/src/config.ts:20-22`):

```ts
export function getIntervalsHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_INTERVALS_HOME || join(homedir(), ".pi", "intervals"));
}
```

with:

```ts
export function getIntervalsHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INTERVALS_HOME || join(homedir(), ".intervals"));
}
```

- [ ] **Step 3: De-pi `src/domain/sync-service.ts`**

Replace (at what was `$SRC/src/sync-service.ts:41`):

```ts
      timeRepo.markSyncFailed(entry.localId, "Missing personId: set INTERVALS_PERSON_ID or run /intervals-setup to configure your Intervals person ID.");
```

with:

```ts
      timeRepo.markSyncFailed(entry.localId, "Missing personId: set INTERVALS_PERSON_ID or run `intervals setup` to configure your Intervals person ID.");
```

- [ ] **Step 4: Copy the 18 domain test files**

```bash
for f in background-sync catalog-store catalog-sync config date-ranges db \
         duration-rounding format intervals-api local-id project-defaults-store \
         runtime start-at sync-service time-editing time-service time-window \
         timer-service; do
  cp "$SRC/tests/$f.test.ts" tests/
done
ls tests/*.test.ts | wc -l   # expected: 19 (18 + scaffold.test.ts)
```

Not copied: `tools.test.ts`, `commands.test.ts` (rewritten in Tasks 4/7), `smoke.test.ts` (asserts the pi entry point; superseded by Task 5's MCP smoke test).

- [ ] **Step 5: Rewrite test import paths and env-var names**

```bash
sed -i 's|"\.\./src/|"../src/domain/|g' tests/*.test.ts
sed -i 's/PI_INTERVALS_HOME/INTERVALS_HOME/g' tests/config.test.ts tests/runtime.test.ts
grep -rn "PI_INTERVALS_HOME\|\.\./src/[a-z]" tests/ ; echo "grep exit: $?"   # expected: no matches, grep exit: 1
```

(The spec's "~14 call sites" is 2 in `config.test.ts` + 12 in `runtime.test.ts` — the sed covers all of them, including the test title string "getIntervalsHome uses INTERVALS_HOME when present".)

- [ ] **Step 6: Delete the scaffold test**

```bash
rm tests/scaffold.test.ts
```

- [ ] **Step 7: Run the suite — the regression net for the port**

```bash
npm run typecheck && npm test
```

Expected: typecheck exits 0; all tests across the 18 files pass, `fail 0`. If anything fails, the move was not faithful — diff the failing file against `$SRC` before changing any logic.

- [ ] **Step 8: Commit**

```bash
git add src/domain tests
git commit -m "feat: port pi-free domain layer and its tests from pi-intervals"
```

---

### Task 3: Make the plain formatters plain (bright becomes an opt-in)

See Findings #2 for why. This is a behavior change to `format.ts` only; every other domain file is untouched.

**Files:**
- Modify: `src/domain/format.ts`, `tests/format.test.ts`

**Interfaces:**
- Consumes: Task 2's `format.ts`.
- Produces (relied on by Tasks 4 and 7):
  - `export type DisplayTimer` (the existing local type, now exported)
  - `formatTimer(timer: DisplayTimer, now?: Date, options?: { bright?: boolean }): string`
  - `formatTimerRows(timers: DisplayTimer[], now?: Date, options?: { bright?: boolean }): string[]`
  - `formatTimerRowsByDate(timers: DisplayTimer[], now?: Date, options?: { bright?: boolean }): string[]`
  - `formatTimeReport(report: TimeReport, options?: { label?: string; bright?: boolean }): string`
  - `formatDuration`, `formatTimeEntry`, `formatSyncSummary` unchanged
  - `formatBrightTimer`, `formatBrightTimerRows`, `formatBrightTimerRowsByDate` **deleted**
  - Default (`bright` omitted or false) output contains **no ANSI escapes anywhere**, including `formatTimeReport`.

- [ ] **Step 1: Update `tests/format.test.ts` to the new API (failing first)**

Apply these edits to the moved file:

1. In the import list, delete `formatBrightTimerRows` and `formatBrightTimerRowsByDate`.
2. In the test `"formatBrightTimerRows keeps visible timer columns aligned"`, replace the call `formatBrightTimerRows([...])` with `formatTimerRows([...], new Date(), { bright: true })` — keep the arguments and assertions as they are (the second parameter `now` may already be passed; keep whatever `now` the test used, adding `{ bright: true }` as the third argument).
3. Same in `"formatBrightTimerRowsByDate groups timers under dated totals"`: `formatBrightTimerRowsByDate(...)` → `formatTimerRowsByDate(..., { bright: true })` as the third argument.
4. Append two new tests at the end of the file:

```ts
test("plain formatters emit no ANSI escape codes", () => {
  const report = {
    startDate: "2026-08-20",
    endDate: "2026-08-20",
    totalSeconds: 3600,
    entries: [
      {
        localId: "te-plain-1",
        projectId: 1,
        worktypeId: 2,
        date: "2026-08-20",
        durationSeconds: 3600,
        description: "plain check",
        billable: true,
        syncStatus: "synced" as const,
        syncAttempts: 0,
        createdAt: "2026-08-20T10:00:00Z",
        updatedAt: "2026-08-20T10:00:00Z",
        projectName: "Proj",
        worktypeName: "Consulting",
      },
    ],
    byProject: [{ projectId: 1, projectName: "Proj", totalSeconds: 3600 }],
  };
  assert.doesNotMatch(formatTimeReport(report as never, { label: "today" }), /\u001b/);
  assert.doesNotMatch(
    formatTimerRows([
      { localId: "t-plain-1", description: "x", startedAt: "2026-08-20T10:00:00Z", elapsedSeconds: 60, state: "stopped", stoppedAt: "2026-08-20T10:01:00Z", createdAt: "2026-08-20T10:00:00Z", updatedAt: "2026-08-20T10:01:00Z" } as never,
    ]).join("\n"),
    /\u001b/,
  );
});

test("bright option emits ANSI escape codes", () => {
  const rows = formatTimerRows([
    { localId: "t-bright-1", description: "x", startedAt: "2026-08-20T10:00:00Z", elapsedSeconds: 60, state: "active", createdAt: "2026-08-20T10:00:00Z", updatedAt: "2026-08-20T10:00:00Z" } as never,
  ], new Date("2026-08-20T10:01:00Z"), { bright: true });
  assert.match(rows.join("\n"), /\u001b\[/);
});
```

(If the existing report/timer fixtures in the moved file have a reusable builder, use it instead of the inline literals — match the file's existing fixture style.)

- [ ] **Step 2: Run to verify failure**

```bash
npx tsx --test tests/format.test.ts
```

Expected: FAIL — compile errors on the removed `formatBright*` imports / missing third parameter, and the new ANSI tests fail against the current `formatTimeReport`.

- [ ] **Step 3: Reshape `src/domain/format.ts`**

Mechanical changes (all row-building logic, widths, grouping, and text stay byte-identical):

1. Export the timer type: `type DisplayTimer = ...` → `export type DisplayTimer = ...`.
2. Delete the four `formatBright*` exports.
3. Change the plain entry points to thread a `bright` flag into the existing internals:

```ts
export interface FormatBrightOption {
  bright?: boolean;
}

export function formatTimer(timer: DisplayTimer, now = new Date(), options: FormatBrightOption = {}): string {
  return formatTimerRows([timer], now, options)[0] ?? "";
}

export function formatTimerRows(timers: DisplayTimer[], now = new Date(), options: FormatBrightOption = {}): string[] {
  return formatTimerRowsInternal(timers, now, options.bright === true);
}

export function formatTimerRowsByDate(timers: DisplayTimer[], now = new Date(), options: FormatBrightOption = {}): string[] {
  return formatTimerRowsByDateInternal(timers, now, options.bright === true);
}
```

4. De-ANSI the report path with a style table. Add:

```ts
interface Style {
  cyan(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
  red(text: string): string;
  dim(text: string): string;
}

const PLAIN_STYLE: Style = {
  cyan: (text) => text,
  yellow: (text) => text,
  green: (text) => text,
  red: (text) => text,
  dim: (text) => text,
};

const BRIGHT_STYLE: Style = {
  cyan: (text) => `${ANSI_BRIGHT_CYAN}${text}${ANSI_RESET}`,
  yellow: (text) => `${ANSI_BRIGHT_YELLOW}${text}${ANSI_RESET}`,
  green: (text) => `${ANSI_BRIGHT_GREEN}${text}${ANSI_RESET}`,
  red: (text) => `${ANSI_BRIGHT_RED}${text}${ANSI_RESET}`,
  dim: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
};
```

5. Change `formatTimeReport(report, options: { label?: string } = {})` to `options: { label?: string; bright?: boolean } = {}`; at the top add `const style = options.bright === true ? BRIGHT_STYLE : PLAIN_STYLE;`; rewrite every inline `${ANSI_X}...${ANSI_RESET}` in `formatTimeReport`, `formatTimeReportEntryRow`, and `formatSyncStatusSymbol` as the equivalent `style.color(...)` call, passing `style` down to those two helpers as a parameter. The wrapped text and separators must be character-identical to today's output when bright.

- [ ] **Step 4: Run the format tests, then the whole suite**

```bash
npx tsx --test tests/format.test.ts && npm run typecheck && npm test
```

Expected: PASS, `fail 0`. (No other file imports `formatBright*` yet — `commands.ts` was never ported.)

- [ ] **Step 5: Commit**

```bash
git add src/domain/format.ts tests/format.test.ts
git commit -m "feat: plain-by-default formatters with opt-in bright ANSI styling"
```

---

### Task 4: Extract the 14 host-agnostic tool descriptors

**Files:**
- Create: `src/tools/index.ts`, `src/domain/timer-display.ts`, `tests/tools.test.ts`

**Interfaces:**
- Consumes: `Runtime` (Task 2), formatters (Task 3).
- Produces (relied on by Tasks 5 and 7):

```ts
// src/tools/index.ts
export interface ToolResult { text: string; details: unknown; }
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;              // a typebox TObject — plain JSON Schema at runtime
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}
export function createToolDescriptors(runtime: Runtime): ToolDescriptor[];

// src/domain/timer-display.ts
export function withLinkedTimeEntryDuration(timeEntryStore: TimeEntryStore, timer: Timer): DisplayTimer;
```

Descriptor `execute` **throws** domain errors (ambiguous project query, timer not found, …); adapters translate them (MCP → `isError: true`, CLI → stderr + exit 1).

- [ ] **Step 1: Write `src/domain/timer-display.ts`** (the helper duplicated today in `$SRC/src/tools.ts:34-38` and `$SRC/src/commands.ts:13-17`, now shared)

```ts
import type { DisplayTimer } from "./format.js";
import type { TimeEntryStore } from "./time-entry-store.js";
import type { Timer } from "./timer-store.js";

export function withLinkedTimeEntryDuration(timeEntryStore: TimeEntryStore, timer: Timer): DisplayTimer {
  if (timer.state !== "stopped") return timer;
  const entry = timeEntryStore.findBySourceTimerId(timer.localId);
  return entry
    ? {
        ...timer,
        displayElapsedSeconds: entry.durationSeconds,
        displayDate: entry.date,
        displayStartAt: entry.startAt,
        displayEndAt: entry.endAt,
      }
    : timer;
}
```

(If `DisplayTimer`'s optional fields are typed `string` but `entry.startAt`/`entry.endAt` are `string | null | undefined` in `TimeEntry`, mirror exactly what `$SRC/src/tools.ts:34-38` compiled with — same property spellings, same types.)

- [ ] **Step 2: Write the failing rewritten `tests/tools.test.ts`**

The old file's fake-pi harness (`fakePi`, `renderToolResultText`, `renderToolCallText`, `fakeTheme`) is deleted. Port `fakeRuntime()` **verbatim** from `$SRC/tests/tools.test.ts:31-95` (the object literal with `calls` counters and canned returns for `timerService`, `timeService`, `timeEntryStore`, `catalogStore`, `defaultsStore`, `trySyncNow`, `deleteTimeEntry`), returning `{ runtime: runtime as unknown as Runtime, calls }`. Then:

```ts
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
```

Then port the behavioral cases from `$SRC/tests/tools.test.ts` (every test that is not about `renderCall`/`renderResult`/`quietToolRenderer`), converting each call site mechanically:

- old: find the tool with `tools.find((t) => t.name === "intervals_start_timer")` and call `tool.execute("call-1", params)`
- new: `descriptorMap(runtime).get("start_timer")!.execute(params)`
- old result assertions on `result.content[0].text` / `result.details` → new `result.text` / `result.details`.

Also add one error-shape case:

```ts
test("lookup_time_entry throws a readable domain error when nothing is linked", async () => {
  const { runtime } = fakeRuntime();
  await assert.rejects(
    descriptorMap(runtime).get("lookup_time_entry")!.execute({ timer_id: "missing" }),
    /no time entry linked to timer: missing/,
  );
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npx tsx --test tests/tools.test.ts
```

Expected: FAIL — `src/tools/index.js` does not exist.

- [ ] **Step 4: Write `src/tools/index.ts`**

Module skeleton (complete):

```ts
import { Type, type Static, type TObject, type TSchema } from "typebox";
import {
  formatDuration,
  formatSyncSummary,
  formatTimeEntry,
  formatTimeReport,
  formatTimer,
  formatTimerRows,
  formatTimerRowsByDate,
} from "../domain/format.js";
import { formatEditableLocalId } from "../domain/local-id.js";
import type { Runtime } from "../domain/runtime.js";
import { parseTimerStartAt } from "../domain/start-at.js";
import { buildStopTimeEditSummary, formatStopTimeEditSummary } from "../domain/time-edit-feedback.js";
import { withLinkedTimeEntryDuration } from "../domain/timer-display.js";

export interface ToolResult {
  text: string;
  details: unknown;
}

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

function tool<S extends TObject>(descriptor: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  execute(params: Static<S>): Promise<ToolResult>;
}): ToolDescriptor {
  return descriptor as unknown as ToolDescriptor;
}

function textResult(text: string, details?: unknown): ToolResult {
  return { text, details: details ?? {} };
}

function resolveProjectQuery(runtime: Runtime, projectQuery: string | undefined): number | undefined {
  if (!projectQuery) return undefined;
  const matches = runtime.catalogStore.searchProjectContext({ query: projectQuery, limit: 5 });
  if (matches.length === 0) {
    throw new Error(`no project found for query: ${projectQuery}`);
  }
  if (matches.length > 1) {
    throw new Error(`project query is ambiguous: ${projectQuery} (${matches.length} matches)`);
  }
  return matches[0].projectId;
}

export function createToolDescriptors(runtime: Runtime): ToolDescriptor[] {
  return [
    // ... 14 tool(...) entries, in the spec's order ...
  ];
}
```

The 14 entries port from `$SRC/src/tools.ts` (read-only) with these **universal transforms**:

- T1 — `pi.registerTool(defineTool({ ... }))` → `tool({ ... })` array element.
- T2 — `name: "intervals_X"` → `name: "X"`; `label:` → `title:`; `parameters:` → `inputSchema:`.
- T3 — delete the `...quietToolRenderer(...)`, `promptSnippet`, and `promptGuidelines` lines entirely.
- T4 — `execute: async (_toolCallId, params) => { ... }` → `execute: async (params) => { ... }`; bodies otherwise verbatim (`textResult` keeps its call shape — only its return type changed).
- T5 — tabs → 2-space indentation.
- T6 — `withLinkedTimeEntryDuration(runtime, t)` → `withLinkedTimeEntryDuration(runtime.timeEntryStore, t)` (the Task 4 Step 1 signature); delete the local copy of that helper (`$SRC/src/tools.ts:34-38`).
- T7 — the two `StringEnum` calls become typebox literal unions (exact replacements below); `import { StringEnum } from "@mariozechner/pi-ai"` and the `pi-coding-agent` import are gone.
- T8 — in `query_time`'s body, `range: params.range as import("./types.js").TimeRange` → `range: params.range` (the literal-union `Static` type already narrows it; no cast, no `types.js` import).

Per-tool source map and description changes:

| # | name | title | source lines in `$SRC/src/tools.ts` | description |
|---|------|-------|--------------------------------------|-------------|
| 1 | `find_project_context` | Find Intervals project context | 41-76 | verbatim |
| 2 | `start_timer` | Start Intervals timer | 78-115 | **extended — exact text below** |
| 3 | `stop_timer` | Stop Intervals timer | 117-159 | verbatim |
| 4 | `edit_timer` | Edit Intervals timer | 161-193 | verbatim |
| 5 | `delete_timer` | Delete Intervals timer | 195-216 | verbatim |
| 6 | `add_time` | Add Intervals time entry | 218-263 | verbatim |
| 7 | `edit_time` | Edit Intervals time entry | 265-338 | **extended — exact text below** |
| 8 | `delete_time` | Delete Intervals time entry | 340-384 | verbatim |
| 9 | `query_time` | Query Intervals time entries | 386-419 | verbatim |
| 10 | `list_timers` | List Intervals timers | 421-448 | verbatim |
| 11 | `lookup_time_entry` | Lookup Intervals time entry | 450-474 | verbatim |
| 12 | `list_time` | List recent Intervals time entries | 476-503 | verbatim |
| 13 | `set_project_defaults` | Set Intervals project defaults | 505-534 | verbatim |
| 14 | `sync_now` | Sync Intervals time entries now | 536-554 | verbatim |

Safety-critical description text (spec §"Prompt guidelines must not live only in the skill" — these rules must survive even when no skill triggers):

`start_timer` description (replaces the original in full):

```
Start a local timer to capture work in progress. Only a description is required. Optional project, worktype, module, and start_at hints can be provided but are not required. Timers are local-only and are not synced to Intervals until stopped. IMPORTANT: Never start a timer implicitly — only call this when the user explicitly asked to start a timer or answered yes when asked. Before starting, check active timers with list_timers; if one is running, ask the user whether to stop it first.
```

`edit_time` description (replaces the original in full):

```
Edit an existing local time entry. If duration_minutes is provided, it is converted to seconds. The entry is marked pending and time-entry sync is triggered. If the entry was previously synced, it will be updated via PUT on the next sync. When the user gives a bare local stop time such as 08:35, pass stop_time (HH:mm) rather than end_at — stop_time recalculates duration from the entry's stored start time; setting end_at alone does not update the duration.
```

The two `StringEnum` replacements (T7), exact:

```ts
// query_time — was: StringEnum([...], { description: "Predefined date range" })
range: Type.Union(
  [
    Type.Literal("today"),
    Type.Literal("yesterday"),
    Type.Literal("this_week"),
    Type.Literal("last_week"),
    Type.Literal("this_month"),
    Type.Literal("last_month"),
    Type.Literal("custom"),
  ],
  { description: "Predefined date range" },
),

// list_timers — was: Type.Optional(StringEnum(["active", "recent"], { description: "Filter by timer state", default: "active" }))
state: Type.Optional(
  Type.Union([Type.Literal("active"), Type.Literal("recent")], {
    description: "Filter by timer state",
    default: "active",
  }),
),
```

Fully worked example of one entry after all transforms (`find_project_context`) — the other 13 follow the same shape:

```ts
tool({
  name: "find_project_context",
  title: "Find Intervals project context",
  description:
    "Search local Intervals project catalog for projects, worktypes, and modules. Returns matching projects with their classifications. This is local-only and does not call the Intervals API.",
  inputSchema: Type.Object({
    query: Type.Optional(Type.String({ description: "Free-text search across project and client names" })),
    project_id: Type.Optional(Type.Number({ description: "Exact project ID to look up" })),
    limit: Type.Optional(Type.Number({ description: "Maximum results to return", default: 20 })),
  }),
  execute: async (params) => {
    const results = runtime.catalogStore.searchProjectContext({
      query: params.query,
      projectId: params.project_id,
      limit: params.limit ?? 20,
    });
    const lines = results.map((r) => {
      const wts = r.worktypes.map((w) => `${w.worktypeId ?? w.id} ${w.name}`).join(", ") || "none";
      const mods = r.modules.map((m) => `${m.moduleId ?? m.id} ${m.name}`).join(", ") || "none";
      return `${r.projectId}: ${r.projectName} (${r.clientName ?? "no client"}) — worktypes: ${wts}; modules: ${mods}`;
    });
    return textResult(lines.join("\n") || "No projects found.", { results });
  },
}),
```

- [ ] **Step 5: Run tools tests, typecheck, full suite**

```bash
npx tsx --test tests/tools.test.ts && npm run typecheck && npm test
```

Expected: PASS, `fail 0`.

- [ ] **Step 6: Confirm no pi packages crept in**

```bash
grep -rn "@mariozechner" src/ package.json ; echo "grep exit: $?"   # expected: no matches, exit 1
```

- [ ] **Step 7: Commit**

```bash
git add src/tools src/domain/timer-display.ts tests/tools.test.ts
git commit -m "feat: extract 14 host-agnostic tool descriptors with safety-critical descriptions"
```

---

### Task 5: MCP stdio adapter, build script, and protocol smoke test

**Files:**
- Create: `src/mcp/server.ts`, `scripts/build.sh`, `tests/mcp-server.test.ts`, `dist/server.mjs` (built, committed)

**Interfaces:**
- Consumes: `createToolDescriptors` / `ToolDescriptor` (Task 4), `createRuntime` (Task 2).
- Produces: `dist/server.mjs` — single-file ESM bundle, runnable as `node dist/server.mjs`, speaking MCP over stdio; `scripts/build.sh [outdir]` (defaults `dist`), reused by Task 9's freshness gate.

- [ ] **Step 1: Write `src/mcp/server.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { createRuntime } from "../domain/runtime.js";
import { createToolDescriptors } from "../tools/index.js";

const runtime = createRuntime();
const descriptors = createToolDescriptors(runtime);
const toolsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

const server = new Server(
  { name: "intervals", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: descriptors.map((descriptor) => ({
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as { type: "object"; [key: string]: unknown },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const descriptor = toolsByName.get(request.params.name);
  if (!descriptor) {
    return errorResult(`unknown tool: ${request.params.name}`);
  }
  const params = request.params.arguments ?? {};
  if (!Value.Check(descriptor.inputSchema, params)) {
    const [first] = [...Value.Errors(descriptor.inputSchema, params)];
    const detail = first ? `${first.path} ${first.message}` : "arguments do not match the schema";
    return errorResult(`invalid arguments for ${descriptor.name}: ${detail}`);
  }
  try {
    const { text, details } = await descriptor.execute(params);
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: details as Record<string, unknown>,
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

server.onclose = () => {
  runtime.close();
};

async function shutdown(): Promise<void> {
  try {
    await server.close();
  } finally {
    runtime.close();
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
```

Notes for the implementer:
- Domain exceptions become `isError: true` results with the message as text — **not** JSON-RPC errors — so the model can read "Invalid worktype_id …" and retry with the right ID (spec §Result shape and errors).
- `structuredContent` carries the descriptor's `details` payload. **Spec assumption 2:** if the installed SDK's `CallToolResult` type rejects `structuredContent` or the negotiated protocol drops it, delete that field and treat `text` as authoritative — do not fight the SDK.
- If the `typebox/value` import subpath differs in the installed typebox version, check `node_modules/typebox/package.json` `exports` — `./value` existed at 1.1.34.
- No `console.*` anywhere; nothing writes to stdout except the SDK transport.

- [ ] **Step 2: Write `scripts/build.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

outdir="${1:-dist}"
mkdir -p "$outdir"

npx esbuild src/mcp/server.ts --bundle --platform=node --format=esm --target=node22 \
  --external:bun:sqlite --outfile="$outdir/server.mjs" --log-level=warning
if [ -f src/cli/main.ts ]; then
  npx esbuild src/cli/main.ts --bundle --platform=node --format=esm --target=node22 \
    --external:bun:sqlite --outfile="$outdir/cli.mjs" --log-level=warning
fi
```

```bash
chmod +x scripts/build.sh
```

(`--platform=node` externalizes `node:*` builtins automatically; `--external:bun:sqlite` keeps the Bun fallback as a runtime dynamic import. `db.ts`'s variable-specifier `import(specifier)` stays dynamic — an esbuild warning about it is acceptable, an error is not. The `[ -f src/cli/main.ts ]` guard drops out mentally in Task 7 when the file exists; the committed script keeps it so Task 5 builds cleanly.)

- [ ] **Step 3: Build and eyeball the bundle**

```bash
npm run build
node -e "console.log(require('node:fs').existsSync('dist/server.mjs'))"   # true
head -c 200 dist/server.mjs   # bundled ESM, no require of @modelcontextprotocol or typebox left unresolved
```

- [ ] **Step 4: Write the failing protocol smoke test `tests/mcp-server.test.ts`**

```ts
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SERVER_PATH = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));

const EXPECTED_TOOL_NAMES = [
  "find_project_context", "start_timer", "stop_timer", "edit_timer", "delete_timer",
  "add_time", "edit_time", "delete_time", "query_time", "list_timers",
  "lookup_time_entry", "list_time", "set_project_defaults", "sync_now",
];

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

function startServer(home: string): {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<JsonRpcMessage>;
  notify(method: string, params?: unknown): void;
  rawStdout(): string;
} {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      INTERVALS_HOME: home,
      INTERVALS_API_KEY: "",
      INTERVALS_BASE_URL: "",
      INTERVALS_PERSON_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let buffer = "";
  let raw = "";
  const pending = new Map<number, (message: JsonRpcMessage) => void>();

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    raw += text;
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as JsonRpcMessage;
      if (message.id != null) pending.get(message.id)?.(message);
    }
  });

  return {
    child,
    request(method, params) {
      const id = nextId++;
      const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return promise;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    rawStdout: () => raw,
  };
}

test("MCP stdio server: initialize → tools/list → tools/call, byte-clean stdout", async () => {
  assert.ok(existsSync(SERVER_PATH), "dist/server.mjs is missing — run `npm run build` first");
  const home = mkdtempSync(join(tmpdir(), "intervals-mcp-smoke-"));
  const server = startServer(home);
  try {
    const init = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    });
    assert.ok(init.result, "initialize returns a result");
    server.notify("notifications/initialized");

    const list = await server.request("tools/list");
    const tools = (list.result as { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> }).tools;
    assert.equal(tools.length, 14);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOL_NAMES].sort());
    for (const t of tools) {
      assert.ok(t.description.length > 0);
      assert.equal(t.inputSchema.type, "object");
    }

    const call = await server.request("tools/call", {
      name: "find_project_context",
      arguments: { query: "no-such-project" },
    });
    const callResult = call.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.notEqual(callResult.isError, true);
    assert.equal(callResult.content[0].text, "No projects found.");

    const bad = await server.request("tools/call", {
      name: "lookup_time_entry",
      arguments: { timer_id: "missing" },
    });
    const badResult = bad.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(badResult.isError, true, "domain errors surface as isError results, not JSON-RPC errors");
    assert.match(badResult.content[0].text, /no time entry linked to timer/);

    const invalid = await server.request("tools/call", {
      name: "query_time",
      arguments: { range: "not-a-range" },
    });
    const invalidResult = invalid.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(invalidResult.isError, true);
    assert.match(invalidResult.content[0].text, /invalid arguments for query_time/);

    // stdio hygiene: every stdout line is a parseable JSON-RPC frame, nothing else.
    for (const line of server.rawStdout().split("\n")) {
      if (line === "") continue;
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(parsed.jsonrpc, "2.0", `non-JSON-RPC bytes on stdout: ${line.slice(0, 80)}`);
    }
  } finally {
    server.child.stdin.end();
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        server.child.kill("SIGKILL");
        resolve();
      }, 3_000);
      server.child.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run the smoke test**

```bash
npx tsx --test tests/mcp-server.test.ts
```

Expected: PASS. If `tools/list` fails schema validation inside the SDK, or `structuredContent` is rejected, apply the assumption-2 fallback from Step 1's notes and re-run.

- [ ] **Step 6: Full suite + commit (dist included)**

```bash
npm run typecheck && npm test
git add src/mcp scripts/build.sh tests/mcp-server.test.ts dist/server.mjs package.json
git commit -m "feat: MCP stdio server adapter with committed bundle and protocol smoke test"
```

---

### Task 6: Concurrency — `busy_timeout` and the `sync_lease`

Several per-session processes share one SQLite file. Three changes: the pragma, the lease table + module, and lease wiring around every sync path.

**Files:**
- Create: `src/domain/sync-lease.ts`, `tests/sync-lease.test.ts`
- Modify: `src/domain/db.ts` (pragma + migration), `src/domain/runtime.ts` (wiring), `tests/db.test.ts` (pragma assertion), `dist/server.mjs` (rebuild)

**Interfaces:**
- Consumes: `Db` (Task 2).
- Produces (relied on by `runtime.ts`):

```ts
// src/domain/sync-lease.ts
export const SYNC_LEASE_TTL_MS = 60_000;
export function claimSyncLease(db: Db, owner: string, nowMs: number, ttlMs?: number): boolean;
export function releaseSyncLease(db: Db, owner: string): void;
export function withSyncLease<T>(db: Db, owner: string, fn: () => Promise<T>, nowMs?: () => number): Promise<T | undefined>;
// withSyncLease returns undefined when the lease is held by another live owner (the caller skipped).
```

- [ ] **Step 1: Write the failing `tests/sync-lease.test.ts`**

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/domain/db.js";
import { claimSyncLease, releaseSyncLease, withSyncLease, SYNC_LEASE_TTL_MS } from "../src/domain/sync-lease.js";

function tempDbPath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "intervals-lease-"));
  return { path: join(dir, "intervals.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const T0 = 1_000_000;

test("two claimants: second claim fails while the first holds", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    assert.equal(claimSyncLease(db, "owner-b", T0), false);
    db.close();
  } finally {
    cleanup();
  }
});

test("renewal: the holder can re-claim its own unexpired lease", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    assert.equal(claimSyncLease(db, "owner-a", T0 + 30_000), true);
    assert.equal(claimSyncLease(db, "owner-b", T0 + 30_000), false);
    db.close();
  } finally {
    cleanup();
  }
});

test("expiry takeover: a crashed holder's lease is claimable after the TTL", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    assert.equal(claimSyncLease(db, "owner-b", T0 + SYNC_LEASE_TTL_MS - 1), false);
    assert.equal(claimSyncLease(db, "owner-b", T0 + SYNC_LEASE_TTL_MS + 1), true);
    db.close();
  } finally {
    cleanup();
  }
});

test("release: another owner can claim immediately after release", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    releaseSyncLease(db, "owner-a");
    assert.equal(claimSyncLease(db, "owner-b", T0), true);
    db.close();
  } finally {
    cleanup();
  }
});

test("release is owner-guarded: a non-holder's release does nothing", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    assert.equal(claimSyncLease(db, "owner-a", T0), true);
    releaseSyncLease(db, "owner-b");
    assert.equal(claimSyncLease(db, "owner-b", T0), false);
    db.close();
  } finally {
    cleanup();
  }
});

test("withSyncLease: runs the function, releases afterward, and skips a concurrent claimant", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const dbA = openDatabase(path);
    const dbB = openDatabase(path);
    let running = 0;
    let overlapped = false;
    const work = async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
      running -= 1;
      return "ran";
    };
    const [a, b] = await Promise.all([
      withSyncLease(dbA, "owner-a", work),
      withSyncLease(dbB, "owner-b", work),
    ]);
    assert.equal(overlapped, false, "sync passes never overlap");
    assert.equal([a, b].filter((r) => r === "ran").length, 1, "exactly one claimant ran");
    assert.equal([a, b].filter((r) => r === undefined).length, 1, "the other skipped");
    // released afterward: a fresh owner claims immediately
    assert.equal(claimSyncLease(dbA, "owner-c", T0), true);
    dbA.close();
    dbB.close();
  } finally {
    cleanup();
  }
});

test("withSyncLease releases the lease when fn throws", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const db = openDatabase(path);
    await assert.rejects(withSyncLease(db, "owner-a", async () => {
      throw new Error("boom");
    }), /boom/);
    assert.equal(claimSyncLease(db, "owner-b", T0), true);
    db.close();
  } finally {
    cleanup();
  }
});
```

Also append to `tests/db.test.ts` (verifies spec assumption 3 — `busy_timeout` honored under `node:sqlite`; the pragma read-back returns a column literally named `timeout`):

```ts
test("openDatabase sets busy_timeout to 5000", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervals-db-pragma-"));
  try {
    const db = openDatabase(join(dir, "t.db"));
    const row = db.prepare("PRAGMA busy_timeout").get<{ timeout: number }>();
    assert.equal(row?.timeout, 5000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

(Match the moved `db.test.ts`'s existing imports/fixtures for `mkdtempSync`/`rmSync`; add them if absent. If the pragma read-back does not report 5000, `node:sqlite` is not honoring it — apply the spec's fallback: wrap `Statement.run` in `db.ts` with a bounded retry on `SQLITE_BUSY` (5 attempts, 100ms backoff) and keep this test asserting whichever mechanism is in place.)

- [ ] **Step 2: Run to verify failure**

```bash
npx tsx --test tests/sync-lease.test.ts tests/db.test.ts
```

Expected: FAIL — `sync-lease.js` missing; pragma test fails (busy_timeout defaults to 0).

- [ ] **Step 3: Implement**

In `src/domain/db.ts`, `openDatabase` gains one line after the WAL pragma:

```ts
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
```

In `migrate(db)`, append inside the existing `db.exec(...)` SQL block, after the index statements:

```sql
    create table if not exists sync_lease (
      id integer primary key check (id = 1),
      owner text,
      expires_at integer not null default 0
    );
```

and after the `db.exec(...)` call add the seed row (idempotent):

```ts
  db.exec("insert or ignore into sync_lease (id, owner, expires_at) values (1, null, 0)");
```

New `src/domain/sync-lease.ts`:

```ts
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
```

Wire into `src/domain/runtime.ts` (this closes the `syncPending` check-then-act race — `findDuplicateRemoteTimeEntry` narrows the duplicate window but two uncoordinated callers can both check, both find nothing, and both POST; serializing **all** sync — background ticks *and* manual `sync_now`, which both flow through `trySyncNow` — through the lease closes it):

1. Add imports: `import { randomUUID } from "node:crypto";` and `import { releaseSyncLease, withSyncLease } from "./sync-lease.js";`
2. Inside `createRuntime`, after `const db = openDatabase(...)`: `const syncOwner = \`${process.pid}:${randomUUID()}\`;`
3. Replace the body of `trySyncNow`:

```ts
  async function trySyncNow(): Promise<{ timeEntriesCreated: number; timeEntriesUpdated: number; failed: number }> {
    if (!apiClient || !personId) {
      return { timeEntriesCreated: 0, timeEntriesUpdated: 0, failed: 0 };
    }
    const result = await withSyncLease(db, syncOwner, () =>
      syncPending({
        timeRepo: timeEntryStore,
        api: apiClient!,
        personId: personId!,
        limit: 50,
        catalog: catalogStore,
      }),
    );
    // Lease held by another process: skip cheaply; pending rows sync on a later pass.
    return result ?? { timeEntriesCreated: 0, timeEntriesUpdated: 0, failed: 0 };
  }
```

(The non-null `!` on `apiClient`/`personId` inside the closure are needed because `reloadCredentials` makes them mutable; the guard above establishes them. If tsc still narrows fine without them, drop them.)

4. In `close()`, release the lease before closing (shutdown backstop):

```ts
  function close(): void {
    stopBackgroundSync();
    if (db.open) {
      releaseSyncLease(db, syncOwner);
      db.close();
    }
  }
```

- [ ] **Step 4: Run the lease and db tests, then the full suite**

```bash
npx tsx --test tests/sync-lease.test.ts tests/db.test.ts && npm run typecheck && npm test
```

Expected: PASS, `fail 0`.

- [ ] **Step 5: Rebuild the committed bundle and commit**

```bash
npm run build
git add src/domain/sync-lease.ts src/domain/db.ts src/domain/runtime.ts tests/sync-lease.test.ts tests/db.test.ts dist/server.mjs
git commit -m "feat: serialize all sync through a sync_lease row; set busy_timeout=5000"
```

---

### Task 7: CLI — 7 commands, setup with hidden input, TTY-gated color

**Files:**
- Create: `src/cli/cli.ts`, `src/cli/main.ts`, `src/cli/prompt.ts`, `bin/intervals`, `tests/cli.test.ts`, `dist/cli.mjs` (built, committed)
- Modify: `package.json` (add `bin`)

**Interfaces:**
- Consumes: `Runtime` (Tasks 2/6), formatters with `{ bright }` (Task 3), `withLinkedTimeEntryDuration` (Task 4).
- Produces:

```ts
// src/cli/cli.ts
export interface CliIo {
  out(line: string): void;          // stdout
  err(line: string): void;          // stderr
  prompt(question: string): Promise<string>;        // visible input
  promptSecret(question: string): Promise<string>;  // hidden input (API key)
  interactive: boolean;             // process.stdin.isTTY
  bright: boolean;                  // process.stdout.isTTY
}
export const USAGE: string;
export function runCli(argv: string[], runtime: Runtime, io: CliIo): Promise<number>;
// exit codes: 0 success, 1 command failure, 2 usage error
```

- [ ] **Step 1: Write the failing `tests/cli.test.ts`**

Port `fakeRuntime(...)` **verbatim** from `$SRC/tests/commands.test.ts` (the version with `calls` counters, `lastEditPatch`, `lastTimerEditPatch`, and options `{ credentialsConfigured?, personId?, credentialSource? }`), casting to `Runtime` the same way. Replace the `fakePi`/`fakeCtx` harness with:

```ts
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
```

Test cases (each a `test(...)` calling `runCli([...args], runtime, io)` and asserting exit code, `out`/`err` lines, and `calls` counters — port assertion details from the corresponding `$SRC/tests/commands.test.ts` case where one exists):

1. `runCli(["status"], ...)` → exit 0; single `out` line containing `Database:`, `Credentials:`, `active timers:`, `pending sync:`, `last project sync:` joined with ` | `.
2. `runCli(["sync-now"], ...)` with `credentialsConfigured: false` → exit 1; `err` mentions `intervals setup`.
3. `runCli(["sync-now"], ...)` with credentials → exit 0; `out[0]` matches `/^Sync complete \| created=/`; `calls.trySyncNow === 1`.
4. `runCli(["sync-projects"], ...)` without credentials → exit 1; with credentials → exit 0, `out[0]` matches `/^Project sync complete:/`, `calls.syncProjectsCatalog === 1`.
5. `runCli(["timers"], ...)` with no timers → exit 0, `out[0] === "No timers found."`.
6. `runCli(["timers", "edit"], ...)` → exit 2, usage line on `err`.
7. `runCli(["timers", "edit", "t1", "project_id=abc"], ...)` → exit 2, `err` mentions `Invalid numeric value for project_id`.
8. `runCli(["timers", "edit", "t1", "project_id=5", "module_id=null"], ...)` → exit 0; `lastTimerEditPatch[0]` deep-equals `{ localId: "t1", projectId: 5, moduleId: null }`.
9. `runCli(["timers", "delete", "t1"], ...)` → exit 0; `calls.deleteTimer === 1`.
10. `runCli(["time"], ...)` → exit 0; queryTime called with `{ range: "today" }`.
11. `runCli(["time", "2026-08-01..2026-08-15"], ...)` → queryTime called with `{ range: "custom", start_date: "2026-08-01", end_date: "2026-08-15" }`.
12. `runCli(["time", "bogus"], ...)` → exit 2; `err[0]` starts `Unknown range: bogus`.
13. `runCli(["time", "edit", "te1", "duration_minutes=90"], ...)` → exit 0; `lastEditPatch[0]` includes `durationSeconds: 5400`; output includes `Updated` and a sync summary line.
14. `runCli(["project-defaults", "10", "5", "7"], ...)` → exit 0; `calls.setProjectDefaults === 1`; `out[0]` = `Project defaults set for 10: worktype=5 module=7`.
15. `runCli(["project-defaults", "10"], ...)` → exit 2 usage.
16. `runCli(["setup"], ...)` with `credentialSource: "env"` → exit 0; out mentions `environment`; `calls.syncProjectsCatalog === 1`.
17. `runCli(["setup"], ...)` no credentials, `interactive: false` → exit 1; `err` mentions `INTERVALS_API_KEY`.
18. Interactive setup writes the config: build the fake runtime with `status()` reporting `home: <mkdtempSync dir>` and `credentialSource: undefined`; `runCli(["setup"], runtime, fakeIo({ inputs: ["secret-key", "42"] }).io)` → exit 0; `JSON.parse(readFileSync(join(home, "config.json"), "utf8"))` deep-includes `{ apiKey: "secret-key", personId: 42 }`; `assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600)` (note the parenthesization — `&` binds looser than `===` in JS); `calls.reloadCredentials === 1`; `calls.syncProjectsCatalog === 1`.
19. `runCli(["frobnicate"], ...)` → exit 2; `err[0]` = `Unknown command: frobnicate`.
20. `runCli([], ...)` → exit 2 with usage on `err`; `runCli(["help"], ...)` → exit 0 with usage on `out`.

- [ ] **Step 2: Run to verify failure**

```bash
npx tsx --test tests/cli.test.ts
```

Expected: FAIL — `src/cli/cli.js` does not exist.

- [ ] **Step 3: Write `src/cli/cli.ts`**

Complete implementation (the field-parsing loops are verbatim ports of `$SRC/src/commands.ts:154-210` and `:247-342` with `ctx.ui.notify(msg, "error")` → `io.err(msg); return 2;`):

```ts
import { loadConfig, saveConfig } from "../domain/config.js";
import {
  formatSyncSummary,
  formatTimeEntry,
  formatTimer,
  formatTimeReport,
  formatTimerRows,
  formatTimerRowsByDate,
} from "../domain/format.js";
import { formatEditableLocalId } from "../domain/local-id.js";
import type { Runtime } from "../domain/runtime.js";
import { buildStopTimeEditSummary, formatStopTimeEditSummary } from "../domain/time-edit-feedback.js";
import { withLinkedTimeEntryDuration } from "../domain/timer-display.js";
import type { TimeRange } from "../domain/types.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  prompt(question: string): Promise<string>;
  promptSecret(question: string): Promise<string>;
  interactive: boolean;
  bright: boolean;
}

export const USAGE = [
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
  "  project-defaults <project_id> <worktype_id> [module_id]   Set project defaults",
].join("\n");

export async function runCli(argv: string[], runtime: Runtime, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return await setup(runtime, io);
      case "status":
        return status(runtime, io);
      case "sync-projects":
        return await syncProjects(runtime, io);
      case "sync-now":
        return await syncNow(runtime, io);
      case "timers":
        return await timers(runtime, io, rest);
      case "time":
        return await time(runtime, io, rest);
      case "project-defaults":
        return projectDefaults(runtime, io, rest);
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case undefined:
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

async function runCatalogSync(runtime: Runtime, io: CliIo): Promise<number> {
  try {
    const result = await runtime.syncProjectsCatalog();
    io.out(
      `Project sync complete: ${result.projects} projects, ${result.worktypes} worktypes, ${result.modules} modules, ${result.clients} clients`,
    );
    return 0;
  } catch (error) {
    io.err(`Project sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function setup(runtime: Runtime, io: CliIo): Promise<number> {
  const current = runtime.status();
  const home = current.home;

  if (current.credentialSource === "env" || current.credentialSource === "config") {
    const source = current.credentialSource === "env" ? "environment" : "config file";
    io.out(`Intervals credentials loaded from ${source}. Database: ${home}`);
    return runCatalogSync(runtime, io);
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
  const personId = personIdInput ? Number(personIdInput) : undefined;
  if (personIdInput && !Number.isFinite(personId)) {
    io.err("Setup cancelled: person ID must be a valid number.");
    return 1;
  }

  const config = loadConfig(home);
  saveConfig(home, { ...config, apiKey, personId: personId ?? config.personId });
  io.out(`Credentials saved to ${home}/config.json`);
  runtime.reloadCredentials();
  return runCatalogSync(runtime, io);
}

function status(runtime: Runtime, io: CliIo): number {
  const current = runtime.status();
  const activeTimers = runtime.timerStore.listActive().length;
  const pendingSync = runtime.timeEntryStore.pendingForSync().length;
  const lastSync = runtime.catalogStore.getLastProjectSync();
  io.out(
    [
      `Database: ${current.home}`,
      `Credentials: ${current.credentialSource ?? "none"}`,
      `active timers: ${activeTimers}`,
      `pending sync: ${pendingSync}`,
      `last project sync: ${lastSync ?? "never"}`,
    ].join(" | "),
  );
  return 0;
}

async function syncProjects(runtime: Runtime, io: CliIo): Promise<number> {
  if (!runtime.status().credentialsConfigured) {
    io.err("Intervals credentials are not configured. Run `intervals setup` first.");
    return 1;
  }
  return runCatalogSync(runtime, io);
}

async function syncNow(runtime: Runtime, io: CliIo): Promise<number> {
  const current = runtime.status();
  if (!current.credentialsConfigured || !current.personId) {
    io.err("Intervals credentials or person ID are not configured. Run `intervals setup` first.");
    return 1;
  }
  const result = await runtime.trySyncNow();
  io.out(`Sync complete | ${formatSyncSummary(result)}`);
  return 0;
}

async function timers(runtime: Runtime, io: CliIo, rest: string[]): Promise<number> {
  const [sub, ...args] = rest;

  if (sub === "edit") {
    const [localId, ...tokens] = args;
    if (!localId) {
      io.err("Usage: intervals timers edit <timer_id> [project_id=...] [worktype_id=...] [module_id=...|null] [description=...]");
      return 2;
    }
    const patch: Record<string, unknown> = { localId };
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
    const timer = runtime.timerService.editTimer(patch as Parameters<typeof runtime.timerService.editTimer>[0]);
    io.out("Timer updated");
    io.out(formatTimer(withLinkedTimeEntryDuration(runtime.timeEntryStore, timer), new Date(), { bright: io.bright }));
    return 0;
  }

  if (sub === "delete") {
    const [localId] = args;
    if (!localId) {
      io.err("Usage: intervals timers delete <timer_id>");
      return 2;
    }
    const timer = runtime.timerService.deleteTimer({ localId });
    io.out("Timer deleted");
    io.out(formatTimer(withLinkedTimeEntryDuration(runtime.timeEntryStore, timer), new Date(), { bright: io.bright }));
    return 0;
  }

  if (sub !== undefined && sub !== "recent") {
    io.err(`Unknown timers subcommand: ${sub}`);
    return 2;
  }

  const list = sub === "recent" ? runtime.timerStore.listRecent(10) : runtime.timerStore.listActive();
  if (list.length === 0) {
    io.out("No timers found.");
    return 0;
  }
  const displayTimers = list.map((t) => withLinkedTimeEntryDuration(runtime.timeEntryStore, t));
  const lines =
    sub === "recent"
      ? formatTimerRowsByDate(displayTimers, new Date(), { bright: io.bright })
      : formatTimerRows(displayTimers, new Date(), { bright: io.bright });
  for (const line of lines) io.out(line);
  return 0;
}

async function time(runtime: Runtime, io: CliIo, rest: string[]): Promise<number> {
  if (rest[0] === "edit") {
    const [localId, ...tokens] = rest.slice(1);
    if (!localId) {
      io.err("Usage: intervals time edit <time_entry_id> [field=value ...]. Use stop_time=HH:mm to change the local stop time and recalculate duration.");
      return 2;
    }
    const patch: Record<string, unknown> = { localId };
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

    const existingEntry = patch.stopTime ? runtime.timeEntryStore.getTimeEntry(localId) : undefined;
    const entry = runtime.timeService.editTime(patch as Parameters<typeof runtime.timeService.editTime>[0]);
    const syncResult = await runtime.trySyncNow();
    io.out(`Updated ${formatEditableLocalId(entry.localId)}`);
    io.out(
      formatTimeEntry({
        ...entry,
        projectName: runtime.catalogStore.getProject(entry.projectId)?.name,
        worktypeName: runtime.catalogStore.getWorktype(entry.projectId, entry.worktypeId)?.name,
        moduleName: entry.moduleId != null ? runtime.catalogStore.getModule(entry.projectId, entry.moduleId)?.name : undefined,
      }),
    );
    if (patch.stopTime && existingEntry) {
      io.out(
        formatStopTimeEditSummary(
          buildStopTimeEditSummary({
            existingEntry,
            date: patch.date as string | undefined,
            startAt: patch.startAt as string | null | undefined,
            stopTime: patch.stopTime as string,
            roundedDurationSeconds: entry.durationSeconds,
          }),
        ),
      );
    }
    io.out(formatSyncSummary(syncResult));
    return 0;
  }

  let range: TimeRange = "today";
  let startDate: string | undefined;
  let endDate: string | undefined;
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

  const report = runtime.timeService.queryTime({ range, start_date: startDate, end_date: endDate });
  io.out(formatTimeReport(report, { label: range.replace(/_/g, "-"), bright: io.bright }));
  return 0;
}

function projectDefaults(runtime: Runtime, io: CliIo, rest: string[]): number {
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
  const moduleId = rest[2] != null ? Number(rest[2]) : undefined;
  if (rest[2] != null && !Number.isFinite(moduleId!)) {
    io.err("Invalid module_id: must be a valid number.");
    return 2;
  }
  runtime.defaultsStore.setProjectDefaults({
    projectId,
    defaultWorktypeId: worktypeId,
    defaultModuleId: moduleId,
  });
  io.out(`Project defaults set for ${projectId}: worktype=${worktypeId} module=${moduleId ?? "none"}`);
  return 0;
}
```

- [ ] **Step 4: Write `src/cli/prompt.ts`** (prompts go to **stderr** so stdout stays pipeable; hidden input never echoes — the API key must not land in terminal scrollback or model context)

```ts
import { createInterface } from "node:readline";

export function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stderr.write(`${question} `);
    input.setRawMode?.(true);
    input.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          input.setRawMode?.(false);
          input.pause();
          input.off("data", onData);
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          input.setRawMode?.(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}
```

- [ ] **Step 5: Write `src/cli/main.ts`** (the bundled entry)

```ts
import { createRuntime } from "../domain/runtime.js";
import { runCli } from "./cli.js";
import { promptHidden, promptVisible } from "./prompt.js";

const runtime = createRuntime();
try {
  process.exitCode = await runCli(process.argv.slice(2), runtime, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompt: promptVisible,
    promptSecret: promptHidden,
    interactive: process.stdin.isTTY === true,
    bright: process.stdout.isTTY === true,
  });
} finally {
  runtime.close();
}
```

- [ ] **Step 6: Write `bin/intervals` and register it**

```js
#!/usr/bin/env node
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
import(pathToFileURL(join(__dirname, "..", "dist", "cli.mjs")).href);
```

```bash
chmod +x bin/intervals
npm pkg set bin.intervals=bin/intervals
```

- [ ] **Step 7: Run CLI tests, typecheck, build, smoke it end-to-end**

```bash
npx tsx --test tests/cli.test.ts && npm run typecheck && npm test
npm run build
INTERVALS_HOME=$(mktemp -d) ./bin/intervals status
```

Expected: tests PASS `fail 0`; the last command prints one status line with `Credentials: none` and exits 0 (run `echo $?` to confirm).

- [ ] **Step 8: Commit**

```bash
git add src/cli bin/intervals tests/cli.test.ts dist/cli.mjs dist/server.mjs package.json
git commit -m "feat: full CLI with setup, hidden API-key input, and TTY-gated color"
```

---

### Task 8: Plugin scaffolding, rewritten skill, slash commands, README

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `skills/intervals-time-entries/SKILL.md`, seven `skills/intervals-*/SKILL.md` slash commands, `README.md`

**Interfaces:**
- Consumes: `dist/server.mjs` (Task 5/6), `dist/cli.mjs` (Task 7).
- Produces: an installable Claude Code plugin `intervals`; tools surfaced as `mcp__intervals__<tool>`.

- [ ] **Step 1: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "intervals",
  "version": "0.1.0",
  "description": "Local-first Intervals time tracking: 14 MCP tools, a zero-dependency CLI, and slash commands."
}
```

- [ ] **Step 2: Write `.claude-plugin/marketplace.json`** (spec assumption 1: repo is both marketplace and plugin via `"source": "./"`; if installation fails on this, nest the plugin under `plugins/intervals/` and point `source` there)

```json
{
  "name": "intervals-mcp",
  "owner": {
    "name": "Six Feet Up"
  },
  "plugins": [
    {
      "name": "intervals",
      "source": "./",
      "description": "Local-first Intervals time tracking: 14 MCP tools, a zero-dependency CLI, and slash commands."
    }
  ]
}
```

- [ ] **Step 3: Write `.mcp.json`**

```json
{
  "mcpServers": {
    "intervals": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"]
    }
  }
}
```

- [ ] **Step 4: Generate the rewritten guidance skill**

The workflow guidance (history-guided classification, ticket-title lookup, ambiguity resolution, project defaults) stays in the skill; only the tool names and storage path change:

```bash
mkdir -p skills/intervals-time-entries
sed -e 's/intervals_\([a-z_]*\)/mcp__intervals__\1/g' \
    -e 's|~/.pi/intervals/|~/.intervals/|g' \
    "$SRC/skills/intervals-time-entries/SKILL.md" > skills/intervals-time-entries/SKILL.md
grep -c "mcp__intervals__" skills/intervals-time-entries/SKILL.md   # expected: ~30 (every former intervals_* reference)
grep -n "intervals_[a-z]\|\.pi/" skills/intervals-time-entries/SKILL.md ; echo "exit: $?"  # expected: no matches, exit 1
```

Then hand-check the frontmatter is intact (`name: intervals-time-entries`, description unchanged) and skim the body once — the sed must not have touched prose words.

- [ ] **Step 5: Write the seven slash-command skills**

Each is a thin shell over the CLI so deterministic output lands verbatim (spec §CLI surface). Create `skills/<name>/SKILL.md` for each row; the body template is identical except for name, description, and the CLI invocation:

| skill dir | description (frontmatter) | CLI invocation |
|---|---|---|
| `intervals-setup` | Configure Intervals credentials and run the initial project sync. | `setup` |
| `intervals-status` | Show Intervals DB path, credential source, active timers, pending sync, last project sync. | `status` |
| `intervals-sync-projects` | Refresh the local Intervals catalog of clients, projects, worktypes, and modules. | `sync-projects` |
| `intervals-sync-now` | Push pending local time entries to Intervals now. | `sync-now` |
| `intervals-timers` | Show active or recent Intervals timers, or edit/delete a timer by ID. | `timers $ARGUMENTS` |
| `intervals-time` | Report local time entries by range, or edit an entry by ID. | `time $ARGUMENTS` |
| `intervals-project-defaults` | Set the default worktype and optional module for a project. | `project-defaults $ARGUMENTS` |

Template (shown for `intervals-status`; substitute per the table):

```markdown
---
name: intervals-status
description: Show Intervals DB path, credential source, active timers, pending sync, last project sync.
disable-model-invocation: true
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" status`

Show the command output above to the user verbatim in a code block. Do not add commentary, do not re-run the command, do not call any mcp__intervals__ tools.
```

For `intervals-setup`, append one extra line to the body: `If the output says credentials are not configured, tell the user to run \`node <plugin>/dist/cli.mjs setup\` (or \`intervals setup\`) in their own terminal — the API key prompt is interactive and hidden.`

- [ ] **Step 6: Write `README.md`**

Content requirements (adapt prose from `$SRC/README.md`, which documents the behavior this server preserves — do not copy pi-specific text):

1. Title `# intervals-mcp` + one-paragraph pitch: standalone MCP server + CLI + Claude Code plugin for local-first Intervals time tracking; timers/entries hit SQLite first, sync in the background or on demand; reports are local-only.
2. **Install (Claude Code plugin):** `/plugin marketplace add /path/to/intervals-mcp` (or `sixfeetup/intervals-mcp` once pushed to GitHub), then `/plugin install intervals@intervals-mcp`. No build step: the bundle is committed, requires only Node >= 22.5.
3. **Install (any MCP host):** JSON snippet `{"command": "node", "args": ["/path/to/intervals-mcp/dist/server.mjs"]}`.
4. **Configuration:** the env-var table from `$SRC/README.md:29-34` with `PI_INTERVALS_HOME` row replaced by `INTERVALS_HOME` (default `~/.intervals/`); the `config.json` key table verbatim; note `intervals setup` writes it 0600 and never puts the key in model context.
5. **CLI:** the 7 commands with one-line descriptions (copy from `USAGE` in Task 7).
6. **Agent tools:** the 14-tool table from `$SRC/README.md:94-109` with names de-prefixed (`mcp__intervals__…` as surfaced in Claude Code).
7. **Slash commands:** the seven `/intervals-*` commands, one line each.
8. **How it works:** port the bullet list from `$SRC/README.md:51-69` (local-only timers, local-first entries, catalog sync, local reports) unchanged in substance.

- [ ] **Step 7: Manual verification (interactive Claude Code session)**

```
claude
/plugin marketplace add /home/roche/projects/intervals-mcp
/plugin install intervals@intervals-mcp
/mcp                         # expect server "intervals": connected, 14 tools
```

Then verify, and record the results in the commit message body:
1. Tool names: confirm they surface as `mcp__intervals__start_timer` etc. If the actual prefix differs (see Findings #5a), update `skills/intervals-time-entries/SKILL.md` tool names to the observed reality and note it.
2. `/intervals-status` executes the CLI and shows the status line (Findings #5b). If `` !`…` `` injection or `$ARGUMENTS` does not work in SKILL.md, move the seven files to `commands/intervals-*.md` (same bodies, same frontmatter minus `name:`) and re-test.
3. Ask Claude "what timers are running?" — it should call `mcp__intervals__list_timers` and report none.

- [ ] **Step 8: Commit**

```bash
git add .claude-plugin .mcp.json skills README.md
git commit -m "feat: Claude Code plugin — marketplace, MCP wiring, rewritten skill, slash commands"
```

---

### Task 9: `npm run check` gates

**Files:**
- Create: `scripts/check.sh`
- Modify: none (the `check` script entry already exists from Task 1)

**Interfaces:**
- Consumes: everything.
- Produces: the single gate = typecheck + tests + pi-ism grep + `console.*` grep + `dist/` freshness (rebuild-and-diff, so a stale committed bundle fails instead of shipping silently).

- [ ] **Step 1: Write `scripts/check.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm run typecheck
npm test

echo "gate: no pi-isms in src/"
if grep -rn -e 'PI_INTERVALS_HOME' -e '\.pi/' -e '/intervals-' -e '@mariozechner' src/; then
  echo "FAIL: pi-ism found in src/ (see matches above)" >&2
  exit 1
fi

echo "gate: no console.* in src/"
if grep -rn 'console\.' src/; then
  echo "FAIL: console.* found in src/ — MCP stdout must stay byte-clean; use process.stderr.write" >&2
  exit 1
fi

echo "gate: committed dist/ is fresh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
./scripts/build.sh "$tmpdir"
diff -q "$tmpdir/server.mjs" dist/server.mjs || { echo "FAIL: dist/server.mjs is stale — run npm run build and commit it" >&2; exit 1; }
diff -q "$tmpdir/cli.mjs" dist/cli.mjs || { echo "FAIL: dist/cli.mjs is stale — run npm run build and commit it" >&2; exit 1; }

echo "check OK"
```

```bash
chmod +x scripts/check.sh
```

- [ ] **Step 2: Prove each gate can fail** (temporarily, nothing committed)

```bash
echo 'console.log("x");' >> src/tools/index.ts && npm run check ; git checkout src/tools/index.ts
# expected: FAIL on the console gate, exit non-zero
printf '\n// stale\n' >> dist/cli.mjs && npm run check ; git checkout dist/cli.mjs
# expected: FAIL on the freshness gate
```

- [ ] **Step 3: Run the real gate**

```bash
npm run check
```

Expected: typecheck ok, all tests pass `fail 0`, three `gate:` lines, `check OK`, exit 0. If the freshness diff fails on identical sources, the local esbuild version differs from the pinned one — run `npm ci` and retry before touching anything else.

- [ ] **Step 4: Commit**

```bash
git add scripts/check.sh
git commit -m "chore: npm run check — typecheck, tests, pi-ism/console greps, dist freshness gate"
```

---

## Self-review record

Checked against the spec after drafting:

- **Spec coverage:** Goal/architecture layers → Tasks 2/4/5/7; tool surface + rename + safety descriptions → Task 4; result shape/errors (`isError`, `structuredContent`) → Task 5; CLI surface incl. subcommand forms, hidden key input, notify→stdout/stderr → Task 7; storage/`INTERVALS_HOME`/`setup` seeding → Tasks 2/7; concurrency (busy_timeout, lease, `withSyncLease` around every sync path) → Task 6; stdio hygiene (test + grep) → Tasks 5/9; de-pi checklist (all four items) → Tasks 2/4 + Task 9 grep; testing section (18 moved files, descriptor tests, CLI tests, MCP smoke, lease tests, check gates) → Tasks 2/4/5/6/7/9; plugin/skill/slash commands + assumptions 1-3 fallbacks → Tasks 5/6/8. Non-goals respected: no migration code, no daemon, `$SRC` never written.
- **Type consistency:** `ToolResult {text, details}`, `ToolDescriptor`, `createToolDescriptors(runtime)` uniform across Tasks 4/5; `withLinkedTimeEntryDuration(timeEntryStore, timer)` uniform across Tasks 4/7; `formatX(…, now, {bright})` / `formatTimeReport(report, {label, bright})` uniform across Tasks 3/4/7; `claimSyncLease/releaseSyncLease/withSyncLease` uniform across Task 6 code, tests, and runtime wiring; `runCli(argv, runtime, io)` uniform across Task 7 code and tests.
- **Placeholder scan:** the only non-inlined code is ports from `$SRC`, always with exact file, line range, and a closed transform list (T1-T8, sed commands) — no TBDs.
