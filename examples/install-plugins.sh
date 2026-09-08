#!/usr/bin/env bash
# Checkout-local consumer smoke. Install OMP18.1.14 separately, then set
# OMP_HOST_ROOT to its @oh-my-pi/pi-coding-agent directory and OMP_BIN to its CLI.
# The runner owns temporary HOME/XDG/OMP state and never connects MCP servers.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec bun "$repo/scripts/check-plugin-loading.ts"
