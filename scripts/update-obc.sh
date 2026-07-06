#!/usr/bin/env bash
# Rebuilds the vendored open-banking-chile tarball at the pinned commit.
# Requires node + npm (dev-time only; the app itself installs and runs with bun alone).
# Usage: scripts/update-obc.sh [commit-ish]   (defaults to the current pin)
set -euo pipefail

PIN="${1:-085faafd}"
# Override to build from a fork, e.g.:
#   OBC_REPO=https://github.com/agucova/open-banking-chile.git scripts/update-obc.sh santander-usd-legs
REPO="${OBC_REPO:-https://github.com/kaihv/open-banking-chile.git}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet "$REPO" "$WORK/obc"
git -C "$WORK/obc" checkout --quiet "$PIN"
RESOLVED="$(git -C "$WORK/obc" rev-parse HEAD)"

(cd "$WORK/obc" && npm ci --silent && npm pack --silent --pack-destination "$WORK")

TGZ="$(ls "$WORK"/open-banking-chile-*.tgz)"
mkdir -p "$ROOT/vendor"
rm -f "$ROOT/vendor"/open-banking-chile-*.tgz
cp "$TGZ" "$ROOT/vendor/"

echo "vendored: vendor/$(basename "$TGZ")"
echo "commit:   $RESOLVED"
echo "sha256:   $(shasum -a 256 "$ROOT/vendor/$(basename "$TGZ")" | cut -d' ' -f1)"
echo
echo "If the filename changed, update the dependency in package.json and run: bun install"
