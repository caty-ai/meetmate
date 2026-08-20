#!/usr/bin/env bash
# scripts/ci/ensure-node.sh — guarantee Node >= 26 on PATH (fail-closed).
#
# Why this exists: the family test-lint gate (reusable-test-lint.yml@ci-v1)
# runs `make test` / `make lint` on a bare GitHub runner with no toolchain
# setup hook, and this suite requires Node 26+ (Node 22 fails with
# cancelledByParent / "Promise resolution is still pending" — measured on
# PR #185's first run). When the system node is too old, download the
# official nodejs.org build for this OS/arch into .cache/node and verify it
# against the SHASUMS256.txt published in the same dist directory (integrity
# anchored to nodejs.org TLS; no独立 pin so the patch line can advance).
#
# Usage: `. scripts/ci/ensure-node.sh` at the repo root. This script enables
# `set -euo pipefail` itself and exports PATH; any failure aborts the caller
# (fail-closed — an unprovable toolchain must not pass the gate).

set -euo pipefail
MIN_MAJOR=26
NODE_DIST_LINE="latest-v26.x"

node_major() { node -p 'parseInt(process.versions.node, 10)' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt "$MIN_MAJOR" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   plat=linux-x64 ;;
    Linux-aarch64)  plat=linux-arm64 ;;
    Darwin-arm64)   plat=darwin-arm64 ;;
    Darwin-x86_64)  plat=darwin-x64 ;;
    *) echo "ensure-node: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  cache_dir="${PWD}/.cache/node"
  mkdir -p "$cache_dir"
  curl -fsSL "https://nodejs.org/dist/${NODE_DIST_LINE}/SHASUMS256.txt" \
    -o "$cache_dir/SHASUMS256.txt"
  tarball=$(grep -oE "node-v[0-9.]+-${plat}\.tar\.gz" "$cache_dir/SHASUMS256.txt" | head -n 1)
  if [ -z "$tarball" ]; then
    echo "ensure-node: no ${plat} tarball listed in SHASUMS256.txt" >&2
    exit 1
  fi
  if [ ! -x "$cache_dir/${tarball%.tar.gz}/bin/node" ]; then
    curl -fsSL "https://nodejs.org/dist/${NODE_DIST_LINE}/${tarball}" \
      -o "$cache_dir/$tarball"
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "$cache_dir" && grep -E "  ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
    else
      (cd "$cache_dir" && grep -E "  ${tarball}\$" SHASUMS256.txt | shasum -a 256 -c -)
    fi
    tar -xzf "$cache_dir/$tarball" -C "$cache_dir"
  fi
  export PATH="$cache_dir/${tarball%.tar.gz}/bin:$PATH"
fi

node_major_val="$(node_major)"
case "$node_major_val" in
  ''|*[!0-9]*)
    echo "ensure-node: could not determine a numeric node major version (got '${node_major_val}') — failing closed." >&2
    exit 1 ;;
esac
if [ "$node_major_val" -lt "$MIN_MAJOR" ]; then
  echo "ensure-node: node on PATH is still $(node --version 2>/dev/null || echo 'missing'), need >= ${MIN_MAJOR} — failing closed." >&2
  exit 1
fi
echo "ensure-node: using node $(node --version)"
