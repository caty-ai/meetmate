#!/usr/bin/env bash
# scripts/ci/lint.sh — lint entry point for `make lint`.
#
# Syntax gate: `node --check` over every tracked JS entry point. This is a
# real, failable gate (a parse error goes red — publication checklist A3
# forbids no-op lint targets), with zero added dependencies. Adopting a
# style linter (eslint) is tracked separately in the quality backlog (#163).
set -euo pipefail
cd "$(dirname "$0")/../.."

. scripts/ci/ensure-node.sh

find src test bin scripts -name '*.js' -print0 | xargs -0 -n 1 node --check
echo "lint: node --check passed for all JS files"
