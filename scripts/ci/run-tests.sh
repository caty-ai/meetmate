#!/usr/bin/env bash
# scripts/ci/run-tests.sh — single test entry point for `make test`.
#
# Emits the T-6 suite reconciliation line (`suites: declared=N executed=M
# skipped=K`) per handbook docs/10 T-6: counts are aggregated dynamically
# (constant output is a T-6 §1 violation), and the line is emitted on EVERY
# exit including failure/interrupt (§4, trap EXIT) so the armed gate
# (require_suite_reconciliation: true) can see declared != executed for a
# partial run and fail closed.
#
# declared = tracked test/*.test.js files (git ls-files — independent of the
# on-disk glob, so an untracked or deleted suite makes the counts disagree)
# + 1 (publication-gate selftest). executed increments only after a suite
# finishes (PASS or FAIL). skipped counts suites deliberately not run — this
# repo declares none, so a nonzero skip can only come from a future explicit
# skip path, never from silence. One process per file keeps the T-6 count one
# observation per suite (not 80 suites off a single process); determinism of
# the per-file run comes from ensure-node.sh pinning the test toolchain to Node
# >= 26.7.0 (nodejs/node#64061, fixed in #64706). See
# docs/test-runner-node-floor.md (#38).
set -euo pipefail
cd "$(dirname "$0")/../.."

. scripts/ci/ensure-node.sh

[ -d node_modules ] || npm ci

declared=0
executed=0
skipped=0
finish() {
  echo "suites: declared=${declared} executed=${executed} skipped=${skipped}"
}
trap finish EXIT

tracked_count=$(git ls-files -- 'test/*.test.js' | wc -l | tr -d ' ')
suites=(test/*.test.js)
declared=$(( tracked_count + 1 ))

if [ "${#suites[@]}" -ne "$tracked_count" ]; then
  echo "suite registration mismatch: git tracks ${tracked_count} test/*.test.js but ${#suites[@]} are on disk — track or remove the difference (fail-closed)." >&2
  exit 1
fi

fail=0
for f in "${suites[@]}"; do
  if node --test --test-concurrency=1 "$f"; then
    executed=$(( executed + 1 ))
  else
    executed=$(( executed + 1 ))
    fail=1
  fi
done

if python3 -B tools/check_publication_gate.py --selftest; then
  executed=$(( executed + 1 ))
else
  executed=$(( executed + 1 ))
  fail=1
fi

exit "$fail"
