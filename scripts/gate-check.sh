#!/usr/bin/env bash
set -euo pipefail

TASK_ID="${1:-}"
REQUIRED_REVIEWERS="${REQUIRED_REVIEWERS:-sonnet,gpt}"
TEST_STATUS_PATH="artifacts/tests/${TASK_ID}.json"

if [[ -z "$TASK_ID" ]]; then
  echo "Usage: scripts/gate-check.sh <task-id>" >&2
  exit 1
fi

IFS=',' read -r -a reviewers <<< "$REQUIRED_REVIEWERS"
missing=0
failed=0
needs_info=0

for reviewer in "${reviewers[@]}"; do
  verdict="artifacts/reviews/${TASK_ID}/verdict-${reviewer}.json"
  if [[ ! -f "$verdict" ]]; then
    echo "MISSING verdict: $verdict"
    missing=1
    continue
  fi
  status="$(node -e "const fs=require('fs'); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String(j.status||''));" "$verdict")"
  echo "${reviewer}: ${status}"
  case "$status" in
    pass) ;;
    fail) failed=1 ;;
    needs-info|needs_info) needs_info=1 ;;
    *) echo "Unknown status in $verdict"; failed=1 ;;
  esac
done

tests_pass="unknown"
if [[ -f "$TEST_STATUS_PATH" ]]; then
  tests_pass="$(node -e "const fs=require('fs'); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String(Boolean(j.tests_pass)));" "$TEST_STATUS_PATH")"
fi

echo "tests_pass: ${tests_pass}"

if [[ "$missing" -eq 1 ]]; then
  echo "GATE_RESULT=BLOCKED_MISSING_REVIEW"
  exit 2
fi
if [[ "$needs_info" -eq 1 ]]; then
  echo "GATE_RESULT=BLOCKED_NEEDS_INFO"
  exit 3
fi
if [[ "$failed" -eq 1 ]]; then
  echo "GATE_RESULT=FAIL"
  exit 4
fi
if [[ "$tests_pass" != "true" ]]; then
  echo "GATE_RESULT=BLOCKED_TESTS"
  exit 5
fi

echo "GATE_RESULT=PASS"
