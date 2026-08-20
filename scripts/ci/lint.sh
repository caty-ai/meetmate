#!/usr/bin/env bash
# scripts/ci/lint.sh — lint entry point for `make lint`.
#
# Syntax gate: `node --check` over every tracked `*.js` file and `bash -n`
# over every tracked `*.sh` file via `git ls-files`. This is a real, failable
# gate (a parse error goes red — publication checklist A3 forbids no-op lint
# targets), with zero added dependencies. Adopting a style linter (eslint) is
# tracked separately in the quality backlog (#163).
set -euo pipefail
cd "$(dirname "$0")/../.."

. scripts/ci/ensure-node.sh

js_count=$(git ls-files -- '*.js' | wc -l | tr -d ' ')
sh_count=$(git ls-files -- '*.sh' | wc -l | tr -d ' ')
if [ "$js_count" -eq 0 ] || [ "$sh_count" -eq 0 ]; then
  echo "lint: enumeration returned js=${js_count} sh=${sh_count} — an empty lint universe cannot prove anything, failing closed." >&2
  exit 1
fi

git ls-files -z -- '*.js' | xargs -0 -n 1 node --check
git ls-files -z -- '*.sh' | xargs -0 -n 1 bash -n

echo "lint: node --check passed for ${js_count} JS files; bash -n passed for ${sh_count} shell files"
