#!/usr/bin/env bash
# Regenerate BetterPlan's protobuf-es TS decoders from betterplan.proto.
#
# Dev-only: pulls buf + protoc-gen-es via bunx (no system protoc/buf needed). The generated
# output under src/adapters/betterplan/gen/ is COMMITTED — runtime never runs codegen. Rerun
# this after editing betterplan.proto, then `bun run check`.
set -euo pipefail
cd "$(dirname "$0")/../src/adapters/betterplan"
bunx --bun @bufbuild/buf generate
echo "Regenerated src/adapters/betterplan/gen/"
