# intervals-mcp

A standalone MCP server, CLI, and Claude Code plugin for local-first Intervals
time tracking. Starting a timer or logging a time entry hits a local SQLite
database first; entries sync to Intervals in the background or on demand.
Reports and queries are always local-only and never call the Intervals API.

## Install (Claude Code plugin)

```
/plugin marketplace add /path/to/intervals-mcp
```

(or, once pushed to GitHub, `/plugin marketplace add sixfeetup/intervals-mcp`)

```
/plugin install intervals@intervals-mcp
```

There is no build step to run: the `dist/` bundle is committed to the repo.
The only requirement is Node >= 22.5.

## Install (any MCP host)

Point your MCP host at the bundled server:

```json
{
  "command": "node",
  "args": ["/path/to/intervals-mcp/dist/server.mjs"]
}
```

## Configuration

Credentials and settings are resolved in this order:

1. Environment variables
2. `config.json` inside `INTERVALS_HOME` (or `~/.intervals/`)

### Environment variables

| Variable              | Description                                                      |
| --------------------- | ------------------------------------------------------------------ |
| `INTERVALS_API_KEY`   | Intervals API key for HTTP Basic auth                            |
| `INTERVALS_BASE_URL`  | Intervals API base URL (default: `https://api.myintervals.com/`) |
| `INTERVALS_PERSON_ID` | Your Intervals person ID (required for time-entry sync)          |
| `INTERVALS_HOME`      | Override the default local storage path (`~/.intervals/`)        |

### `config.json` keys

If you prefer file-based configuration, create `config.json` inside `INTERVALS_HOME` (or `~/.intervals/`):

| Key              | Type     | Description                                                      |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `apiKey`         | `string` | Intervals API key for HTTP Basic auth                            |
| `baseUrl`        | `string` | Intervals API base URL (default: `https://api.myintervals.com/`) |
| `personId`       | `number` | Your Intervals person ID (required for time-entry sync)          |
| `syncIntervalMs` | `number` | Background sync interval in milliseconds                         |

Running `intervals setup` (or the `/intervals-setup` slash command) writes
this file with `0600` permissions and never puts the API key in model
context — the key is entered at an interactive, hidden prompt in your own
terminal.

## CLI

The bundle ships a zero-dependency CLI (`dist/cli.mjs`, exposed as `intervals`
via `package.json#bin` when installed as a package):

| Command | Description |
| --- | --- |
| `setup` | Configure credentials and run initial project sync |
| `status` | Show DB path, credential source, timers, pending sync |
| `sync-projects` | Refresh the local project catalog |
| `sync-now` | Push pending time entries to Intervals now |
| `timers [recent]` / `timers edit <timer_id> [field=value ...]` / `timers delete <timer_id>` | Show, edit, or delete timers |
| `time [range]` / `time edit <id> [field=value ...]` | Report time entries (`today`, `yesterday`, `this-week`, `last-week`, `this-month`, `last-month`, `YYYY-MM-DD`, `YYYY-MM-DD..YYYY-MM-DD`), or edit one (`stop_time=HH:mm` recalculates duration) |
| `project-defaults <project_id> <worktype_id> [module_id]` | Set project defaults |

Run `node dist/cli.mjs help` (or `intervals help`) for the full usage text.

## Agent tools

When installed as a Claude Code plugin, tools surface with the `mcp__intervals__` prefix:

| Tool | Description |
| --- | --- |
| `mcp__intervals__find_project_context` | Search the local project catalog for IDs and classifications (local-only) |
| `mcp__intervals__start_timer` | Start a local timer with a simple description and optional `start_at`; project/worktype/module are optional |
| `mcp__intervals__stop_timer` | Stop a timer, resolve classification, create a pending time entry, and sync |
| `mcp__intervals__edit_timer` | Update description or project/worktype/module hints on a running local timer |
| `mcp__intervals__delete_timer` | Safely delete an active timer or stopped timer with no linked time entry |
| `mcp__intervals__add_time` | Add a completed time entry directly (duration in minutes) |
| `mcp__intervals__edit_time` | Edit an existing local time entry by short ID or linked timer ID; use `stop_time` for local stop-time changes that recalculate duration |
| `mcp__intervals__delete_time` | Delete a local or synced time entry by short ID or linked timer ID |
| `mcp__intervals__query_time` | Report time entries by date range and project filter (local-only) |
| `mcp__intervals__list_timers` | List active or recent local timers |
| `mcp__intervals__lookup_time_entry` | Map a stopped local timer ID to the linked local time entry ID |
| `mcp__intervals__list_time` | List recent local time entries with sync status |
| `mcp__intervals__set_project_defaults` | Configure default worktype/module for a project |
| `mcp__intervals__sync_now` | Immediately retry syncing pending time entries to Intervals |

`mcp__intervals__start_timer` accepts optional `start_at` values for retroactive
local timer starts. Use `HH:mm` or `H:mm` for today in local time,
`YYYY-MM-DD HH:mm` for a local date/time, or an ISO datetime with an explicit
offset/timezone. Future `start_at` values are rejected.

## Slash commands

| Command | Description |
| --- | --- |
| `/intervals-setup` | Configure Intervals credentials and run the initial project sync |
| `/intervals-status` | Show Intervals DB path, credential source, active timers, pending sync, last project sync |
| `/intervals-sync-projects` | Refresh the local Intervals catalog of clients, projects, worktypes, and modules |
| `/intervals-sync-now` | Push pending local time entries to Intervals now |
| `/intervals-timers` | Show active or recent Intervals timers, or edit/delete a timer by ID |
| `/intervals-time` | Report local time entries by range, or edit an entry by ID |
| `/intervals-project-defaults` | Set the default worktype and optional module for a project |

## How it works

- **Timers are local-only.** Starting a timer writes a lightweight local row
  with just a description. Project, worktype, and module hints are optional.
- **Running timers can be reclassified locally.** Edit a timer's project,
  worktype, or module hints before stopping it; the updated classification is
  applied when the time entry is created.
- **Stop/apply creates a time entry.** When you stop a timer, you provide (or
  resolve) the project and worktype. The server creates a pending time entry
  and immediately tries to sync it to Intervals.
- **Time entries are local-first.** `mcp__intervals__add_time`,
  `mcp__intervals__edit_time`, and `mcp__intervals__stop_timer` all persist to
  SQLite before any network call. If sync fails, the entry stays local with a
  `failed` or `pending` status and can be retried.
- **Catalog sync stores active rows.** Project sync fetches all catalog pages,
  keeps active projects and active classifications, and retains clients
  referenced by active projects.
- **Reports are local-only.** `query_time` and `/intervals-time` read from
  SQLite and never call the Intervals API.

## Developer note

If you open this repository itself in Claude Code, you may see the `intervals`
MCP server listed as failed to connect. That's expected: the repo-root
`.mcp.json` is the plugin's own configuration, and it references
`${CLAUDE_PLUGIN_ROOT}`, which is only set when the plugin is installed
through `/plugin install`. Editing this repo's source doesn't install the
plugin, so the variable is unset and the server can't start. It's safe to
reject or ignore any prompt about it while working on the code.
