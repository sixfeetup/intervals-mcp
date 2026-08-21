---
name: intervals-time-entries
description: Use when starting, stopping, editing, syncing, reviewing, or retroactively adding Intervals timers or time entries.
---

# Intervals Time Entries

## Overview

Time entry classification should be history-guided, not guess-driven. Never assume a timer should be started just because work is beginning. Before creating or changing timers/time entries, inspect recent local timers and time entries, ask for confirmation before starting any timer unless the user explicitly requested it, and use similar prior work to choose project/worktype/module.

## When to Use

Use this skill for any request involving Intervals time tracking, including:

- starting a timer, e.g. “add timer for FOU-406” or “start a timer for Clubhouse”
- stopping or editing a timer
- adding retroactive time entries
- fixing failed syncs
- reviewing recent time entries or answering “what did I log?”
- choosing project, worktype, or module for time tracking

## Required Context Check

Always gather context before creating, editing, or syncing a time entry or timer:

1. Check recent time entries with `mcp__plugin_intervals_intervals__list_time`.
2. Check active/recent timers with `mcp__plugin_intervals_intervals__list_timers` when the request involves timers or could be affected by an active timer. Before starting a new timer, if any active timer exists, ask whether it should be stopped first.
3. Use `mcp__plugin_intervals_intervals__query_time` for date-scoped requests such as “today”, “yesterday”, “this week”, or when recent entries are not enough.
4. Use `mcp__plugin_intervals_intervals__find_project_context` to resolve project names, ticket prefixes, worktypes, modules, and ambiguous project matches.
5. Use the current working directory and path as an additional clue. For example, if the user is working under a client/project repo, prefer recent entries and project matches related to that repo.

Do not skip the recent-entry check just because the user supplied a ticket key or project name.

## No Implicit Timer Starts

When work is beginning but the user did not explicitly ask to start a timer:

1. Ask whether an Intervals timer should be started for this work.
2. Do not start a timer until the user answers yes.
3. Do not treat a coding task, project name, ticket key, current directory, or prior time-entry pattern as permission to start a timer.
4. If the user says no or does not answer, continue the work without starting a timer.

## Active Timer Check Before Starting

Before starting any timer after explicit user request or confirmation:

1. Check active timers first with `mcp__plugin_intervals_intervals__list_timers`.
2. If any active timer is running, ask whether to stop it before starting the new timer. Name the active timer(s) and keep the question concise.
3. Do not start the new timer until the user answers, unless the user already explicitly said to keep existing timers running or to allow multiple active timers.
4. If the user says to stop an active timer, stop it with the best available classification, then start the requested new timer.

## Ticket-only Timer Requests

When the user asks to start a timer using only a ticket key, e.g. “start a timer for FOU-406”:

1. Do not use the bare ticket key as the timer description if the issue title can be found.
2. Look for the issue title in recent time entries/timers, local project context, ticket tools, or other available issue-tracker context.
3. Use the description format `TICKET-123: Issue title`, e.g. `FOU-406: Upgrade to Python 3.14`.
4. Preserve exact ticket casing and title wording from the source when available.
5. Do not invent an issue title. If the title cannot be found safely, use the ticket key plus any user-supplied work description, or ask a concise follow-up if the description would otherwise be too vague for a useful time entry.

## Classification Process

### 1. Match against recent history first

Look for recent entries/timers with the same or similar:

- ticket prefix or ticket key, e.g. `FOU-406`, `FOU-*`
- project code, e.g. `CLBH005-NS`
- client/project name, e.g. `Clubhouse`
- repo/path clue from the current directory
- description pattern, e.g. “FOU-406: Fix mypy 1.20.2 upgrade type-check failures”

If a recent matching entry exists, reuse its:

- project ID
- worktype ID
- module ID, including leaving it blank if the prior matching entry was blank
- description style, unless the user provided a more specific description

Example: if the user says “add timer for FOU-406” and a recent entry says:

```text
CLBH005-NS ... /foundations (Consulting) | FOU-406: Fix mypy 1.20.2 upgrade type-check failures
```

start the timer with the same project, worktype, and module, and use the same ticket description style.

### 2. Resolve ambiguity with history and path clues

If a project name is ambiguous, prefer the most likely recent match rather than asking immediately.

Example: if “Clubhouse” matches both `CLBH005-NS` and `CLBH006-NS`, inspect recent entries. If recent work is on `CLBH005-NS` with the same ticket prefix or repo/path context, use `CLBH005-NS` and state that it was chosen based on recent matching entries.

Ask a clarification question only when:

- there is no recent/history/path signal,
- multiple candidates have equally strong recent matches, or
- the choice could materially change billing/client classification.

Ask one concise question and include the leading candidates.

### 3. New project handling

A “new project” means there is no sufficiently similar recent time entry/timer for the project/worktype/module combination.

When starting a timer for a new project after the user explicitly requested or confirmed the timer:

1. Do not block timer start solely because defaults are unknown.
2. Resolve project/worktype/module as far as possible from `mcp__plugin_intervals_intervals__find_project_context` and path clues.
3. Ask the user whether they want to set default worktype and module for that project, especially if they had to choose them manually.
4. If the user confirms, call `mcp__plugin_intervals_intervals__set_project_defaults` with the confirmed worktype/module.

For retroactive entries, resolve required project/worktype before creating the entry. If worktype/module cannot be inferred safely, ask before adding the entry.

## Tool Guidelines

- Use `mcp__plugin_intervals_intervals__start_timer` only when the user explicitly requested a timer or answered yes when asked whether to start one. First check active timers and ask whether any running timer should be stopped. Include project/worktype/module hints when confidently inferred from recent history.
- Use `mcp__plugin_intervals_intervals__stop_timer` when the user finishes work. Re-check recent entries if classification is missing or stale. NB: Do not modify the timer project, worktype or module if it already set.
- Use `mcp__plugin_intervals_intervals__add_time` for retroactive entries. Convert durations to minutes.
- Use `mcp__plugin_intervals_intervals__edit_time` to fix failed or incorrect entries, then verify with `mcp__plugin_intervals_intervals__list_time` or `mcp__plugin_intervals_intervals__query_time`.
- Use `mcp__plugin_intervals_intervals__delete_time` when the user wants to remove a time entry. If the user references a stopped timer, pass `timer_id` so the linked time entry is deleted.
- Use `mcp__plugin_intervals_intervals__sync_now` after adding/editing/stopping if the tool did not already sync, or when the user explicitly asks to retry sync.
- Use `mcp__plugin_intervals_intervals__find_project_context` before relying on a project/worktype/module ID that came from text rather than a previous time entry.
- Do not read `~/.intervals/intervals.db` directly for normal workflows. Use `mcp__plugin_intervals_intervals__list_time`, `mcp__plugin_intervals_intervals__query_time`, and `mcp__plugin_intervals_intervals__lookup_time_entry`; these expose local time entry IDs, local start/end windows, sync status, and timer-to-entry mapping without direct DB access.
- When the user asks to change an entry's stop/end time using a bare time like `08:35`, use `stop_time` instead of raw `end_at`. `stop_time` is interpreted as local time and recalculates duration from the entry's stored start time.
- If the user gives a stopped timer ID when editing a derived time entry, use `mcp__plugin_intervals_intervals__lookup_time_entry(timer_id=...)` or `mcp__plugin_intervals_intervals__edit_time(timer_id=...)`; do not map the timer to a time entry through SQLite.

## ID Safety

Be careful with local catalog row IDs versus Intervals remote IDs.

- Prefer IDs returned directly by `mcp__plugin_intervals_intervals__find_project_context` and IDs shown in synced/recent time-entry tool output.
- If sync fails with an “Invalid worktype_id” or “local catalog row id” error, correct the entry using the Intervals worktype/module IDs suggested by the error or by `mcp__plugin_intervals_intervals__find_project_context`, then retry sync.
- Do not reuse raw database IDs unless the tools identify them as valid Intervals IDs.

## Response Pattern

When you create, edit, or start a timer/time entry, briefly report:

- what was created or changed
- the selected project/worktype/module
- why that classification was chosen, e.g. “matched recent FOU-406 entry” or “matched current repo path”
- sync status, when applicable

Keep the response concise.

## Common Mistakes

- Starting a timer for a coding/task request without first asking whether the user wants a timer.
- Starting a new timer while another timer is active without first asking whether the active timer should be stopped.
- Starting a timer from only the ticket key without checking recent entries.
- Using a bare ticket key like `FOU-406` as the description when the issue title is available.
- Asking the user to disambiguate before checking history and current path.
- Forgetting to preserve the module from similar prior work.
- Using a local catalog row ID where Intervals expects a remote worktype/module ID.
- Setting project defaults without explicit user confirmation.
- Reclassifying a pre-classified timer at stop time based on recent work or current repo path. Preserve timer classification unless the user asks to change it.
- Setting `end_at` without updating duration. Use `stop_time` for user-facing stop-time changes.
- Treating stored UTC ISO timestamps as the user's local wall-clock time. For bare user times, use local-time semantic fields.
- Querying SQLite directly to find a time entry ID that official tools now expose.
