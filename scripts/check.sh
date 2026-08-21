#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm run typecheck
npm test

echo "gate: no pi-isms in src/"
if grep -rn -e 'PI_INTERVALS_HOME' -e '\.pi/' -e '@mariozechner' src/; then
  echo "FAIL: pi-ism found in src/ (see matches above)" >&2
  exit 1
fi
# /intervals- catches pi slash-command references, but must not trip on the domain
# layer's legitimate `./intervals-api.js` import (src/domain/runtime.ts).
if grep -rn '/intervals-' src/ | grep -v 'intervals-api'; then
  echo "FAIL: pi slash-command reference (/intervals-*) found in src/ (see matches above)" >&2
  exit 1
fi

echo "gate: no console.* in src/"
if grep -rn 'console\.' src/; then
  echo "FAIL: console.* found in src/ — MCP stdout must stay byte-clean; use process.stderr.write" >&2
  exit 1
fi

echo "gate: committed dist/ is fresh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
./scripts/build.sh "$tmpdir"
diff -q "$tmpdir/server.mjs" dist/server.mjs || { echo "FAIL: dist/server.mjs is stale — run npm run build and commit it" >&2; exit 1; }
diff -q "$tmpdir/cli.mjs" dist/cli.mjs || { echo "FAIL: dist/cli.mjs is stale — run npm run build and commit it" >&2; exit 1; }

echo "check OK"
