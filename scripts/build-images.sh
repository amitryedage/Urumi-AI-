#!/usr/bin/env bash
# Build all images. Usage: scripts/build-images.sh [tag] [registry-prefix]
#   local:  scripts/build-images.sh dev            -> urumi/<name>:dev
#   ghcr:   scripts/build-images.sh 0.1.0 ghcr.io/you/urumi-   -> ghcr.io/you/urumi-<name>:0.1.0
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-dev}"
PREFIX="${2:-urumi/}"
build() { echo "==> ${PREFIX}$1:${TAG}"; docker build -q -t "${PREFIX}$1:${TAG}" "$2" >/dev/null; }
build wordpress     images/wordpress
build everything-mcp images/everything-mcp
build woo-mcp       apps/woo-mcp
build toolbox-mcp   apps/toolbox-mcp
build gateway       apps/gateway
build dashboard     apps/dashboard
