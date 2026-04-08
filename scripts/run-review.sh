#!/usr/bin/env bash
set -euo pipefail

TASK_ID="${1:-}"
BASE_REF="${2:-HEAD~1}"

if [[ -z "$TASK_ID" ]]; then
  echo "Usage: scripts/run-review.sh <task-id> [base-ref]" >&2
  exit 1
fi

SPEC_PATH="specs/${TASK_ID}.yaml"
if [[ ! -f "$SPEC_PATH" ]]; then
  echo "Spec not found: $SPEC_PATH" >&2
  exit 1
fi

BUNDLE_DIR="artifacts/review-bundles/${TASK_ID}"
REVIEW_DIR="artifacts/reviews/${TASK_ID}"
mkdir -p "$BUNDLE_DIR" "$REVIEW_DIR"

git diff "$BASE_REF" -- . > "$BUNDLE_DIR/diff.patch"
cp "$SPEC_PATH" "$BUNDLE_DIR/spec.yaml"

cat > "$BUNDLE_DIR/README.md" <<EOF
# Review bundle for ${TASK_ID}

Contents:
- spec.yaml
- diff.patch

Reviewers should return JSON matching prompts/reviewer.md and save files to:
- artifacts/reviews/${TASK_ID}/verdict-sonnet.json
- artifacts/reviews/${TASK_ID}/verdict-gpt.json
EOF

echo "Prepared review bundle: $BUNDLE_DIR"
echo "Next: send spec.yaml + diff.patch to reviewers using prompts/reviewer.md"
