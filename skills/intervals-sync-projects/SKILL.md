---
name: intervals-sync-projects
description: Refresh the local Intervals catalog of clients, projects, worktypes, and modules.
disable-model-invocation: true
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" sync-projects`

Show the command output above to the user verbatim in a code block. Do not add commentary, do not re-run the command, do not call any mcp__intervals__ tools.
