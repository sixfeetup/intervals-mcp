# intervals-mcp Design

Date: 2026-08-20
Status: Approved (amended 2026-08-21 with corrections found while writing the
implementation plan; see that plan's Findings section)

## Goal

Build `intervals-mcp`: a standalone, host-agnostic MCP server for local-first Intervals
time tracking, plus a CLI and a Claude Code plugin that packages both.

The server exposes the same 14 time-tracking tools that the `pi-intervals` extension
exposes today, but speaks the Model Context Protocol over stdio instead of binding to
pi's `ExtensionAPI`. Any MCP host — Claude Code, pi, Claude Desktop, Cursor — can use it.

## Non-goals

- **No data migration.** This repo starts on an empty database. Nothing reads, moves, or
  falls back to `~/.pi/intervals/`.
- **No pi coupling of any kind.** No pi environment variables, no pi path names, no pi
  packages, no references to pi slash commands in user-facing strings.
- **No daemon.** The server runs per-session over stdio. A shared long-lived process is a
  later transport, not part of this design.
- **The fate of `pi-intervals` is out of scope.** Whether pi registers this MCP server or
  keeps its extension is that repo's decision. Nothing here depends on it.

## Source material

The domain layer and its tests are ported from the working `pi-intervals` extension at:

    /home/roche/projects/pi/extensions/pi-intervals

Treat it as **read-only reference**. It is a live tool in daily use, and nothing in this
design changes it.

- Its `src/` holds 26 files. 21 are the pi-free domain layer listed under Architecture.
  `index.ts`, `tools.ts`, and `commands.ts` are the pi adapters being replaced;
  `quiet-tool-rendering.ts` and `command-args.ts` are dropped (the latter split pi's raw
  command strings into tokens — the CLI receives argv already tokenized by the shell).
- Its `tests/` holds 21 files; the 18 that are not `tools.test.ts`, `commands.test.ts`,
  or `smoke.test.ts` move across. `smoke.test.ts` only asserts the pi entry point exports
  a function; the MCP protocol smoke test supersedes it.
- Its `README.md` documents the tool and command behaviour this server must preserve.
- `docs/designs/2026-04-24-pi-intervals.md` records the original local-first data model.

## Conventions carried over

- ESM (`"type": "module"`), TypeScript `strict`, `module` and `moduleResolution` both
  `NodeNext`, target ES2022 — so relative imports carry the `.js` extension.
- Node engine `>= 22.5.0`, required for `node:sqlite`.
- `test`: `tsx --test tests/**/*.test.ts`. `typecheck`: `tsc --noEmit`. `check` runs both
  plus the gates described under Testing.
- Indentation is 2 spaces. (`pi-intervals/src/tools.ts` uses tabs; that outlier is not
  carried over.)

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Transport | stdio MCP server | Simplest lifecycle, works in every MCP host, and the transport is an adapter — HTTP can be added later without touching anything below it. |
| Process model | One process per host session | Timers are DB rows with a `startAt`; elapsed time is computed at read time, so no state needs a shared process. Concurrency is handled at the data layer instead. |
| Code home | Domain layer moves here | One source of truth. Copying it would mean two divergent copies of ~2,900 lines; a third shared package would mean three repos to version. |
| Storage home | `INTERVALS_HOME` or `~/.intervals/` | Pi-free path, same directory shape as before. |
| Front-end | MCP server + full CLI | The formatters already exist; a CLI gives terminal use with zero agent tokens and keeps the API key out of model context. |
| Distribution | Claude Code plugin in this repo, committed bundle | Zero runtime deps and no install step. Colleagues install with one command. |

## Architecture

Three layers. The host adapters are thin shells over a shared tool registry.

```
intervals-mcp/
├── .claude-plugin/
│   ├── plugin.json              # plugin "intervals"
│   └── marketplace.json         # single-plugin marketplace
├── .mcp.json                    # stdio: node ${CLAUDE_PLUGIN_ROOT}/dist/server.mjs
├── dist/                        # committed esbuild bundles: server.mjs, cli.mjs;
│                                #   cli.mjs is shebanged + executable (package bin)
├── src/
│   ├── domain/                  # 21 files moved from pi-intervals/src
│   ├── tools/index.ts           # 14 host-agnostic tool descriptors
│   ├── mcp/server.ts            # StdioServerTransport adapter
│   └── cli/main.ts              # 7 commands
├── skills/
│   ├── intervals-time-entries/  # model-invoked guidance skill
│   └── intervals-*/             # user-invoked slash commands
└── tests/
```

### Layer 1 — domain

Moved verbatim (modulo the de-pi-ing checklist below) from `pi-intervals/src`, which has
zero pi imports outside the three adapter files:

`background-sync`, `catalog-store`, `catalog-sync`, `config`, `date-ranges`, `db`,
`duration-rounding`, `format`, `intervals-api`, `local-id`, `project-defaults-store`,
`runtime`, `start-at`, `sync-service`, `time-edit-feedback`, `time-entry-store`,
`timer-service`, `timer-store`, `time-service`, `time-window`, `types`.

`command-args.ts` is dropped — `splitCommandArgs` existed only to tokenize pi's raw
command strings, and the CLI receives argv already tokenized by the shell.
`quiet-tool-rendering.ts` is dropped — it implements pi's TUI renderer shape, which has
no MCP equivalent.

### Layer 2 — tool descriptors

`src/tools/index.ts` exports an array of host-agnostic descriptors:

```ts
{ name, title, description, inputSchema, execute(params) => { text, details } }
```

No host types, no rendering. This is the pivot that makes both adapters thin (~60 lines
each) and makes a future HTTP transport a third file rather than a rewrite.

### Layer 3 — adapters

- `src/mcp/server.ts` maps descriptors onto `tools/list` and `tools/call`.
- `src/cli/main.ts` maps descriptors and runtime methods onto argv.

### Naming

npm package `intervals-mcp`; Claude Code plugin `intervals`; MCP server key `intervals`,
which is what produces the `mcp__intervals__*` tool names.

### Runtime dependencies: none

`@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` are dropped entirely.
`@modelcontextprotocol/sdk` and `typebox` are build-time only because esbuild bundles
them, and `node:sqlite` is built into Node. `dist/server.mjs` is therefore a single file
requiring only Node >= 22.5 (Bun also works via the existing `bun:sqlite` fallback in
`db.ts`), so the plugin needs no install step.

## Tool surface

14 tools, semantics unchanged, renamed without the `intervals_` prefix:

`find_project_context`, `start_timer`, `stop_timer`, `edit_timer`, `delete_timer`,
`add_time`, `edit_time`, `delete_time`, `query_time`, `list_timers`, `lookup_time_entry`,
`list_time`, `set_project_defaults`, `sync_now`.

Claude Code exposes MCP tools as `mcp__<server>__<tool>`, so keeping the prefix would
produce `mcp__intervals__intervals_start_timer`. The skill must be rewritten for the
`mcp__` prefix regardless, so the rename costs nothing.

### Prompt guidelines must not live only in the skill

pi injects each tool's `promptGuidelines` into every system prompt. MCP has no equivalent
— a skill loads only when it triggers. Guidelines therefore split by criticality:

- **Safety-critical rules go into tool `description` fields**, which are always present
  once tools are listed: never start a timer implicitly, check active timers before
  starting a new one, prefer `stop_time` over raw `end_at`.
- **Fuller workflow guidance stays in the skill**: history-guided classification,
  ticket-title lookup, ambiguity resolution, project defaults.

Without this split, an untriggered skill means the agent starts timers it shouldn't.

### Result shape and errors

Results are `content: [{ type: "text", text }]` plus `structuredContent` carrying the
existing `details` payload. Domain exceptions (ambiguous project query, timer not found,
invalid worktype ID) become `isError: true` with the message as text, not JSON-RPC
errors, so the model can read the message and correct itself — this is what keeps the
"invalid worktype_id -> retry with the right ID" loop working.

MCP output must be ANSI-free, and today's "plain" formatters are not: `formatTimeReport`
— which `query_time` renders — embeds ANSI codes directly. The port therefore makes every
formatter plain by default with an opt-in `{ bright: true }` option and deletes the
`formatBright*` exports; the CLI passes `bright` only when stdout is a TTY.

## CLI surface

`intervals setup | status | sync-projects | sync-now | timers | time | project-defaults`

One-to-one with the pi slash commands they replace, including the subcommand forms
(`timers recent`, `timers edit <id> field=value`, `timers delete <id>`, `time <range>`,
`time edit <id> field=value`). `ctx.ui.notify` becomes stdout/stderr; `ctx.ui.input`
becomes readline with hidden input for the API key, so the key never enters model
context.

Claude Code slash commands are thin `skills/<name>/SKILL.md` files with
`allowed-tools: [Bash]` whose body shells out to the CLI with the `!` prefix, so
deterministic output lands verbatim with no model interpretation.

## Storage

Resolution is one rule: `INTERVALS_HOME` if set, otherwise `~/.intervals/`, created on
first use.

```
~/.intervals/
  config.json     # mode 0600: apiKey, baseUrl, personId, syncIntervalMs
  intervals.db
```

Credential precedence is unchanged: `INTERVALS_API_KEY` / `INTERVALS_BASE_URL` /
`INTERVALS_PERSON_ID` environment variables first, then `config.json`.

`intervals setup` seeds a fresh install: prompt for credentials, write `config.json`, then
run a full catalog sync so clients, projects, worktypes, and modules are rebuilt from the
Intervals API.

## Concurrency

One process per session means several processes can hold the same SQLite file. Three
things need handling:

1. **`PRAGMA busy_timeout = 5000`** alongside the existing `journal_mode = WAL` pragma, so
   a blocked writer waits rather than failing with `SQLITE_BUSY`.

2. **A `sync_lease` table** — a single row claimed with a conditional update:

   ```sql
   UPDATE sync_lease SET owner = ?, expires_at = ?
    WHERE id = 1 AND (expires_at < ? OR owner = ?)
   ```

   A claim succeeds only when `changes === 1`. The lease is claimed per sync pass and
   released in a `finally` when the pass ends, with an owner-guarded release on shutdown
   as a backstop. The `owner = ?` clause lets a holder re-claim (renew) its own lease,
   and `syncPending` renews before each entry via an optional `renewLease` hook, so a
   pass slower than the TTL keeps the lease. TTL is 60s, which covers holders that crash
   mid-pass. A long-held per-process lease would not work: the default 10-minute tick
   cannot sustain a 60s TTL, and it would block another session's manual `sync_now` for
   minutes.

3. **`withSyncLease()` wraps every sync path** — background ticks *and* manual `sync_now`.
   This is the part that matters. `syncPending` reads `pendingForSync(limit)` and then
   POSTs in a loop with no row claim, so it is a check-then-act race:
   `findDuplicateRemoteTimeEntry` narrows the window but two callers can both check, both
   find nothing, and both create. Deduping background loops alone would not close it,
   because a manual sync can still collide with a background one. Serializing all sync
   through the lease does.

Non-holders skip cheaply: a background tick or manual `sync_now` that fails the claim
returns zero counts, and pending rows sync on a later pass.

## stdio hygiene

Only MCP frames may be written to stdout; all diagnostics go to stderr. `src/` is
currently free of `console.*` calls and must stay that way. Enforced by a test asserting
byte-clean stdout plus a grep in `npm run check`. Note `db.ts` suppresses Node's
`node:sqlite` experimental warning via `process.emitWarning`, which writes to stderr and
is therefore safe.

## De-pi-ing checklist

A finite list, verified against the current `pi-intervals` source. Line references are
pre-move locations in that repo; after the move these files live under `src/domain/`.

- `config.ts:21` — `PI_INTERVALS_HOME || ~/.pi/intervals` becomes
  `INTERVALS_HOME || ~/.intervals`
- `sync-service.ts:41` — the "run `/intervals-setup`" message points at `intervals setup`
- `tools.ts` — the two `StringEnum` calls become TypeBox unions, dropping
  `@mariozechner/pi-ai`
- 14 `PI_INTERVALS_HOME` call sites (12 in `tests/runtime.test.ts`, 2 in
  `tests/config.test.ts`)

`npm run check` greps `src/` for `PI_INTERVALS_HOME`, `.pi/`, `/intervals-`, and
`@mariozechner`, failing on any hit, so pi-isms cannot creep back in. The `/intervals-`
gate excludes the `intervals-api` module name, which the domain layer legitimately
imports (`runtime.ts` imports `./intervals-api.js`).

## Testing

- The 18 domain test files move with import-path and environment-variable renames. Green
  tests are the proof the move was faithful — this is the regression net for the port.
- `tools.test.ts` is rewritten against the descriptor list; the fake-pi harness is deleted.
- `commands.test.ts` becomes CLI tests.
- **New: MCP protocol smoke test.** Spawn `dist/server.mjs`, walk `initialize` ->
  `tools/list` -> `tools/call`, assert 14 tools and byte-clean stdout.
- **New: lease tests.** Two claimants, expiry takeover, renewal, release.

`npm run check` = typecheck + test + pi-ism grep + `console.*` grep + a `dist/` freshness
check that rebuilds and diffs, so a stale committed bundle fails rather than shipping
silently.

## Assumptions to verify during implementation

Each has a decided fallback, so none blocks progress:

1. **Single-plugin marketplace** — `.claude-plugin/marketplace.json` with `"source": "./"`.
   If a repo cannot be both marketplace and plugin, nest the plugin under
   `plugins/intervals/` and point `source` there, as the official marketplace does.
2. **`structuredContent` support** in the installed MCP SDK and negotiated protocol
   revision. If unavailable, drop `details` and treat the text output as authoritative.
3. **`PRAGMA busy_timeout` under `node:sqlite`** via `db.exec`. If it is not honored, wrap
   writes in a bounded retry on `SQLITE_BUSY`.
4. **`mcp__intervals__*` tool naming** for plugin-provided MCP servers. If Claude Code
   prefixes plugin server tools differently, update the skill's tool names to the
   observed reality.
5. **`` !`command` `` injection and `$ARGUMENTS`** work inside plugin `skills/*/SKILL.md`
   files. If not, the seven slash commands move to `commands/*.md` files, which support
   both.

## Order of work

1. Scaffold the repo; move the domain layer and its tests to green.
2. Extract the 14 tool descriptors; drop the pi packages.
3. MCP stdio adapter plus the protocol smoke test.
4. `sync_lease` and `busy_timeout`.
5. CLI, including `setup` and home resolution.
6. Plugin scaffolding, the rewritten skill, and the slash commands.
7. `npm run check` gates: pi-ism grep, `console.*` grep, `dist/` freshness.

## Next step

The implementation plan is written: `docs/superpowers/plans/2026-08-21-intervals-mcp.md`,
nine tasks following the Order of work above. The next action is to execute it task by
task.

This repo currently contains only this spec and that plan — no `package.json`, no `src/`,
no git remote.
