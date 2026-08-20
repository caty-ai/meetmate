#!/usr/bin/env bash
# scripts/ci/run-tests.sh — single test entry point for `make test`.
#
# Runs the full Node test suite serialized (Node 26's parallel test-runner
# worker IPC is flaky for this suite — locally verified invocation, see the
# PR #185 CI notes) plus the vendored publication-gate selftest, then emits
# the T-6 suite reconciliation line (`suites: declared=N executed=M
# skipped=K`) that the armed test-lint gate requires
# (require_suite_reconciliation: true — publication checklist A5).
#
# declared = every test/*.test.js on disk + 1 (publication-gate selftest).
# Any suite failure aborts before the reconciliation line is printed, so a
# partial run can never report itself as reconciled (fail-closed).
set -euo pipefail
cd "$(dirname "$0")/../.."

. scripts/ci/ensure-node.sh

suites=(test/*.test.js)
declared=$(( ${#suites[@]} + 1 ))

node --test --test-concurrency=1 "${suites[@]}"

python3 -B tools/check_publication_gate.py --selftest

echo "suites: declared=${declared} executed=${declared} skipped=0"
