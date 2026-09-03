# Family CI gate entry points (handbook T-1 / publication checklist A2).
# The family reusable test-lint gate (@ci-v1) runs `make test` / `make lint`
# on a bare runner with no toolchain setup — scripts/ci/ensure-node.sh
# bootstraps a current Node 26 when the system node is < 26.7.0. Node 22 fails
# the required test-runner semantics (measured on PR #185); Node 26.0–26.6
# flake on a test-runner IPC bug, nodejs/node#64061. See
# docs/test-runner-node-floor.md / #38.
# run-tests.sh installs dependencies after bootstrapping Node; exit codes propagate.

.PHONY: test lint deps

deps:
	@[ -d node_modules ] || npm ci

test:
	bash scripts/ci/run-tests.sh

lint:
	bash scripts/ci/lint.sh
