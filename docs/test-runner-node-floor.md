# Test-runner Node floor: why `make test` needs Node >= 26.7.0

Tracking issue: [#38](https://github.com/caty-ai/meetmate/issues/38). Runtime users are unaffected (`engines.node >= 26` is unchanged); this floor applies to running the test suite.

## Symptom

`make test` (or a bare `node --test test/<file>.test.js`) goes red at file level, non-deterministically, with:

```
Error: Unable to deserialize cloned data due to invalid or unsupported version.
```

The failing file changes from run to run, its reported `tests N` count is truncated (e.g. `tests 3` instead of `tests 7`), and every subtest that did run passed. It fires with one file per process and `--test-concurrency=1`, and more often under host load.

## Root cause

Node's `node:test` runner streams worker results to the parent over IPC. In Node 26.0 through 26.6 the parent mis-reads a length field in that stream once it wraps past the signed-int range, so a later frame is handed to the structured-clone deserializer with garbage in the version header. Upstream: [nodejs/node#64061](https://github.com/nodejs/node/issues/64061), fixed by [nodejs/node#64706](https://github.com/nodejs/node/pull/64706) ("test_runner: convert to uint during deserialization"), released in v26.7.0.

## Measurement (2026-09-04, macOS arm64, this repo at main `23b1a45`)

Each cell is 8 standalone runs of each of the three most-hit suites (`first-token-delegation`, `llm-pipeline-provider`, `handoff-outcomes`).

| Node | `--test-isolation` | result |
|---|---|---|
| 26.5.0 | process (default) | 6 of 8 runs of `llm-pipeline-provider` red with the deserialize error, counts truncated to 2–3 of 7 |
| 26.5.0 | none | 24 / 24 green |
| 26.8.1 | process (default) | 24 / 24 green |
| 26.8.1 | none | 24 / 24 green |

Raw logs and the run script are in the #38 lane comment. CI (`test-lint.yml` via the family gate) was already green throughout because `scripts/ci/ensure-node.sh` bootstraps `latest-v26.x` on the bare runner; only local hosts sitting on 26.0–26.6 hit the bug.

## Options considered

1. **Raise the test-toolchain floor to 26.7.0** (chosen). `scripts/ci/ensure-node.sh` now compares the full version against `26.7.0` and bootstraps a current 26.x into `.cache/node` when the host is older. Fixes the root cause with the upstream patch, keeps per-file process isolation (each suite still gets a fresh module cache and env), and leaves the T-6 count at one observation per suite.
2. `--test-isolation=none`. Also green in the matrix, but it runs all 80 suites in one process: module caches, `process.env` mutation and mocks would leak across files, and a hang in one suite blocks the T-6 line for all of them. Rejected as a workaround that trades an upstream bug for our own coupling.
3. Pin an exact Node version. Rejected: `ensure-node.sh` deliberately tracks `latest-v26.x` so security patches land without a lane; a floor is enough because the bug is fixed in every 26.x from 26.7.0 on.
4. Swap the runner (vitest etc.). Out of proportion for a fixed upstream bug; the suite depends on `node:test` semantics.

## How to reproduce (and confirm the fix)

```bash
# on a host with Node 26.0–26.6 on PATH
for i in 1 2 3 4 5 6 7 8; do node --test test/llm-pipeline-provider.test.js 2>&1 | grep -E 'tests [0-9]+|deserialize'; done
# expect truncated counts / deserialize errors in some runs

make test          # ensure-node bootstraps >= 26.7.0 into .cache/node; expect suites: declared=80 executed=80 skipped=0
```
