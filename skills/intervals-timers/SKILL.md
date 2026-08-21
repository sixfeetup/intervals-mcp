---
name: intervals-timers
description: Show active or recent Intervals timers, or edit/delete a timer by ID.
disable-model-invocation: true
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" timers $ARGUMENTS`

Show the command output above to the user verbatim in a code block. Do not add commentary, do not re-run the command, do not call any mcp__intervals__ tools.
