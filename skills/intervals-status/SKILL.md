---
name: intervals-status
description: Show Intervals DB path, credential source, active timers, pending sync, last project sync.
disable-model-invocation: true
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" status`

Show the command output above to the user verbatim in a code block. Do not add commentary, do not re-run the command, do not call any mcp__intervals__ tools.
