# Family CI gate entry points (handbook T-1 / publication checklist A2).
# The family reusable test-lint gate (@ci-v1) runs `make test` / `make lint`
# on a bare runner with no toolchain setup — scripts/ci/ensure-node.sh
# bootstraps Node 26 when the system node is older (this suite requires
# Node >= 26 test-runner semantics; Node 22 fails, measured on PR #185).
# Exit codes propagate: any failing step fails the target (no `|| true`).

.PHONY: test lint deps

deps:
	@[ -d node_modules ] || npm ci

test: deps
	bash scripts/ci/run-tests.sh

lint:
	bash scripts/ci/lint.sh
