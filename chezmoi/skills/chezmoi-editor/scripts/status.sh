#!/usr/bin/env bash
set -euo pipefail

chezmoi status || true
echo
chezmoi diff || true
