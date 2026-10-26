#!/usr/bin/env bash
# Delete the kind cluster (all data). Generated secrets in .secrets/ are kept.
set -euo pipefail
pkill -f "scripts/ipv6-proxy.js" 2>/dev/null || true
kind delete cluster --name urumi
