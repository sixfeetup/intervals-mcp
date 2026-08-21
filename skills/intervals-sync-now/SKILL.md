---
name: intervals-sync-now
description: Push pending local time entries to Intervals now.
disable-model-invocation: true
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" sync-now`

Show the command output above to the user verbatim in a code block. Do not add commentary, do not re-run the command, do not call any mcp__plugin_intervals_intervals__ tools.
