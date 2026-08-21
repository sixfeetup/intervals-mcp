---
name: intervals-time
description: Report local time entries by range, or edit an entry by ID.
disable-model-invocation: true
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" time $ARGUMENTS`

Show the command output above to the user verbatim in a code block. Do not add commentary, do not re-run the command, do not call any mcp__intervals__ tools.
