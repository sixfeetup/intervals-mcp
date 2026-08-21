#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

outdir="${1:-dist}"
mkdir -p "$outdir"

npx esbuild src/mcp/server.ts --bundle --platform=node --format=esm --target=node22 \
  --external:bun:sqlite --outfile="$outdir/server.mjs" --log-level=warning
if [ -f src/cli/main.ts ]; then
  npx esbuild src/cli/main.ts --bundle --platform=node --format=esm --target=node22 \
    --banner:js='#!/usr/bin/env node' \
    --external:bun:sqlite --outfile="$outdir/cli.mjs" --log-level=warning
  chmod +x "$outdir/cli.mjs"
fi
