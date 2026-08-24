#!/usr/bin/env bash
set -euo pipefail

ran=0
skipped=0
failed=0
failures=()

skip() {
  echo "==> skip: $1"
  skipped=$((skipped + 1))
}

run_cmd() {
  local label="$1"
  shift
  echo "==> $label"
  echo "+ $*"
  set +e
  "$@"
  local status=$?
  set -e
  ran=$((ran + 1))
  if [ "$status" -ne 0 ]; then
    failed=$((failed + 1))
    failures+=("$label exited $status: $*")
  fi
}

json_parser() {
  # jq is preferred, but a JS project reliably has node and most hosts have
  # python3; without this fallback `has_script` answered false for every script
  # whenever jq was absent, so a repo with a working `verify` script reported
  # "No supported verification workflow detected" and exited 1.
  if command -v jq >/dev/null 2>&1; then
    echo jq
  elif command -v node >/dev/null 2>&1; then
    echo node
  elif command -v python3 >/dev/null 2>&1; then
    echo python3
  fi
}

has_script() {
  local name="$1"
  case "$(json_parser)" in
  jq) jq -e --arg name "$name" '.scripts[$name] // empty' package.json >/dev/null 2>&1 ;;
  node) node -e '
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const v = (pkg.scripts || {})[process.argv[1]];
      process.exit(typeof v === "string" && v.length > 0 ? 0 : 1);
    ' "$name" >/dev/null 2>&1 ;;
  python3) python3 -c '
import json, sys
with open("package.json") as fh:
    scripts = json.load(fh).get("scripts") or {}
value = scripts.get(sys.argv[1])
sys.exit(0 if isinstance(value, str) and value else 1)
' "$name" >/dev/null 2>&1 ;;
  *) return 1 ;;
  esac
}

detect_js_runner() {
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    echo pnpm
  elif { [ -f bun.lock ] || [ -f bun.lockb ]; } && command -v bun >/dev/null 2>&1; then
    echo bun
  elif command -v npm >/dev/null 2>&1; then
    echo npm
  elif command -v pnpm >/dev/null 2>&1; then
    echo pnpm
  elif command -v bun >/dev/null 2>&1; then
    echo bun
  fi
}

run_js_script() {
  local runner="$1"
  local script="$2"
  case "$runner" in
    pnpm) run_cmd "package script: $script" pnpm run "$script" ;;
    bun) run_cmd "package script: $script" bun run "$script" ;;
    npm) run_cmd "package script: $script" npm run "$script" ;;
  esac
}

run_js_exec() {
  local runner="$1"
  local label="$2"
  shift 2
  case "$runner" in
    pnpm) run_cmd "$label" pnpm exec "$@" ;;
    bun) run_cmd "$label" bunx "$@" ;;
    npm) run_cmd "$label" npx --no-install "$@" ;;
  esac
}

if [ -f justfile ] || [ -f Justfile ]; then
  if command -v just >/dev/null 2>&1; then
    if just --list 2>/dev/null | grep -qE '^[[:space:]]*verify([[:space:]]|$)'; then
      run_cmd "just verify" just verify
    fi
  else
    skip "justfile present but just is not installed"
  fi
fi

if [ -f Makefile ]; then
  if command -v make >/dev/null 2>&1; then
    if grep -qE '^verify:' Makefile; then
      run_cmd "make verify" make verify
    fi
  else
    skip "Makefile present but make is not installed"
  fi
fi

if [ -f package.json ]; then
  runner="$(detect_js_runner || true)"
  if [ -z "${runner:-}" ]; then
    skip "package.json present but no supported JS package runner is installed"
  elif [ -z "$(json_parser)" ]; then
    skip "package.json present but no JSON parser (jq, node, python3) is installed"
  elif has_script verify; then
    run_js_script "$runner" verify
  else
    for script in typecheck lint test build; do
      if has_script "$script"; then
        run_js_script "$runner" "$script"
      fi
    done
    if [ -f tsconfig.json ] && ! has_script typecheck; then
      run_js_exec "$runner" "TypeScript check" tsc --noEmit
    fi
  fi
fi

if [ -f Cargo.toml ]; then
  if command -v cargo >/dev/null 2>&1; then
    run_cmd "cargo fmt" cargo fmt --check
    run_cmd "cargo clippy" cargo clippy --all-targets --all-features -- -D warnings
    run_cmd "cargo test" cargo test
  else
    skip "Cargo.toml present but cargo is not installed"
  fi
fi

if [ -f go.mod ]; then
  if command -v go >/dev/null 2>&1; then
    if command -v golangci-lint >/dev/null 2>&1; then
      run_cmd "golangci-lint" golangci-lint run
    else
      skip "golangci-lint is not installed"
    fi
    run_cmd "go test" go test ./...
    run_cmd "go build" go build ./...
  else
    skip "go.mod present but go is not installed"
  fi
fi

if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  if command -v ruff >/dev/null 2>&1; then
    run_cmd "ruff check" ruff check .
    run_cmd "ruff format" ruff format --check .
  else
    skip "ruff is not installed"
  fi
  if command -v pyright >/dev/null 2>&1; then
    run_cmd "pyright" pyright .
  else
    skip "pyright is not installed"
  fi
  if command -v pytest >/dev/null 2>&1; then
    run_cmd "pytest" pytest
  else
    skip "pytest is not installed"
  fi
fi

echo "==> summary"
echo "ran: $ran"
echo "skipped: $skipped"
echo "failed: $failed"

if [ "$ran" -eq 0 ]; then
  echo "No supported verification workflow detected." >&2
  exit 1
fi

if [ "$failed" -ne 0 ]; then
  printf 'Failures:\n' >&2
  printf -- '- %s\n' "${failures[@]}" >&2
  exit 1
fi
