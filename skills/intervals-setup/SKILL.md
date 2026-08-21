---
name: intervals-setup
description: Configure Intervals credentials and run the initial project sync.
disable-model-invocation: true
allowed-tools: ["Bash"]
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" setup`

Show the command output above to the user verbatim in a code block. Do not add commentary, do not re-run the command, do not call any mcp__intervals__ tools.

If the output says credentials are not configured, tell the user to run `node <plugin>/dist/cli.mjs setup` (or `intervals setup`) in their own terminal — the API key prompt is interactive and hidden.
