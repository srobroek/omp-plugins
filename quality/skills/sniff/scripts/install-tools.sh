#!/usr/bin/env bash
set -euo pipefail

# install-tools.sh
#
# Probe for and (on request) install the code-smell detection tools the sniff
# skill drives. Tools are ALWAYS optional: sniff degrades gracefully when one is
# absent. This script never installs anything without an explicit --install /
# --all, and never uses sudo. When no package manager fits a tool, it prints the
# manual install step instead of failing.
#
# Modes:
#   install-tools.sh --probe                 report installed/missing per bundle (default)
#   install-tools.sh --list                  list bundles and their tools
#   install-tools.sh --install <bundle>...   install the named bundle(s)
#   install-tools.sh --all                   install every bundle
#   install-tools.sh --dry-run --install ... show the commands without running them
#
# Bundles:
#   core      semgrep lizard scc            (cross-language: smells, complexity, triage)
#   dup       jscpd                         (cross-language duplication; use only where a language lacks native dup)
#   security  trivy checkov gitleaks        (IaC/container misconfig, CVEs, secrets)
#   rust      (clippy via rustup) cargo-machete
#   go        golangci-lint deadcode(x/tools)
#   python    ruff vulture pylint mypy pyright
#   js-ts     eslint(+sonarjs/unicorn) knip madge type-coverage dependency-cruiser biome  (project-local)
#   shell     shellcheck shfmt
#   sql       sqlfluff
#   css       stylelint(+configs) stylelint-declaration-strict-value  (project-local)
#   data      yamllint taplo check-jsonschema
#   api       vacuum spectral oasdiff graphql-inspector buf
#   infra     hadolint tflint actionlint kube-linter kubeconform
#   docs      markdownlint-cli2 lychee cspell
# Per-tool default-on vs opt-in tiers live in the language docs (the source of
# truth); this script just provisions. Records: name|probe-bin|key|hint[|pkg][|mise-spec]
#
# Portability floor: bash 3.2.57 + BSD userland. No mapfile, no associative
# arrays, no GNU-only flags.

# ---- bundle + tool tables -------------------------------------------------
# Each tool is a "name|probe-binary|installer-key|hint" record. installer-key
# selects how to install it (see install_one). probe-binary is what we look for
# on PATH; some tools (eslint/stylelint/knip) are project-local and probed via
# the project, not globally.

BUNDLES="core dup security rust go python js-ts shell sql css data api infra docs"

tools_for() {
  # echo the tool records (one per line) for a bundle.
  case "$1" in
    core)
      echo "semgrep|semgrep|pipx|pipx install semgrep  (or: brew install semgrep)"
      echo "lizard|lizard|pipx|pipx install lizard"
      echo "scc|scc|brew|brew install scc  (or: go install github.com/boyter/scc/v3@latest)||go:github.com/boyter/scc/v3"
      ;;
    dup)
      echo "jscpd|jscpd|npm|npm i -g jscpd"
      ;;
    security)
      echo "trivy|trivy|brew|brew install trivy  (or: https://aquasecurity.github.io/trivy)"
      echo "checkov|checkov|pipx|pipx install checkov"
      echo "gitleaks|gitleaks|brew|brew install gitleaks  (used by the secrets-scan package too)"
      ;;
    rust)
      echo "clippy|cargo-clippy|rustup|rustup component add clippy"
      echo "cargo-machete|cargo-machete|cargo|cargo install cargo-machete"
      ;;
    go)
      echo "golangci-lint|golangci-lint|brew|brew install golangci-lint  (or: https://golangci-lint.run)"
      echo "deadcode|deadcode|go|go install golang.org/x/tools/cmd/deadcode@latest||go:golang.org/x/tools/cmd/deadcode"
      ;;
    python)
      echo "ruff|ruff|pipx|pipx install ruff  (or: uv tool install ruff)"
      echo "vulture|vulture|pipx|pipx install vulture"
      echo "pylint|pylint|pipx|pipx install pylint"
      echo "mypy|mypy|pipx|pipx install mypy"
      echo "pyright|pyright|pipx|pipx install pyright  (or: npm i -g pyright)"
      ;;
    js-ts)
      echo "eslint|eslint|npm-local|npm i -D eslint typescript-eslint eslint-plugin-sonarjs eslint-plugin-unicorn  (project-local; sonarjs = cognitive-complexity + dup)"
      echo "knip|knip|npm-local|npm i -D knip  (project-local; dead files/exports/deps)"
      echo "madge|madge|npm-local|npm i -D madge  (project-local; circular deps)"
      echo "type-coverage|type-coverage|npm-local|npm i -D type-coverage  (project-local; any-leakage %)"
      echo "dependency-cruiser|depcruise|npm-local|npm i -D dependency-cruiser  (project-local; cycles + architecture boundaries)"
      echo "biome|biome|npm-local|npm i -D --save-exact @biomejs/biome  (project-local; fast lint+fmt, JSON too)"
      echo "svelte-check|svelte-check|npm-local|npm i -D svelte-check  (project-local; Svelte compiler/type/a11y diagnostics)"
      echo "vue-tsc|vue-tsc|npm-local|npm i -D vue-tsc  (project-local; Vue SFC-aware type checking)"
      ;;
    shell)
      echo "shellcheck|shellcheck|brew|brew install shellcheck"
      echo "shfmt|shfmt|brew|brew install shfmt"
      ;;
    sql)
      echo "sqlfluff|sqlfluff|pipx|pipx install sqlfluff"
      echo "squawk|squawk|cargo|cargo install squawk  (Postgres migration safety)"
      ;;
    css)
      echo "stylelint|stylelint|npm-local|npm i -D stylelint stylelint-config-standard stylelint-config-recommended-scss  (project-local; add -recommended-vue for Vue SFC styles)"
      echo "stylelint-declaration-strict-value|stylelint|npm-local|npm i -D stylelint-declaration-strict-value  (project-local; OPT-IN: enforce tokens over magic colors/sizes)"
      ;;
    data)
      echo "yamllint|yamllint|pipx|pipx install yamllint"
      echo "taplo|taplo|cargo|cargo install taplo-cli --locked  (or: brew install taplo)|taplo-cli"
      echo "check-jsonschema|check-jsonschema|pipx|pipx install check-jsonschema"
      ;;
    api)
      echo "vacuum|vacuum|brew|brew install daveshanley/vacuum/vacuum  (OpenAPI lint; Go, fast, spectral-ruleset compatible)|daveshanley/vacuum/vacuum"
      echo "spectral|spectral|npm|npm i -g @stoplight/spectral-cli  (OpenAPI lint; Node alternative to vacuum)|@stoplight/spectral-cli"
      echo "oasdiff|oasdiff|brew|brew install oasdiff/homebrew-oasdiff/oasdiff  (OPT-IN: OpenAPI breaking-change vs base; needs CI baseline)|oasdiff/homebrew-oasdiff/oasdiff"
      echo "graphql-inspector|graphql-inspector|npm|npm i -g @graphql-inspector/cli  (OPT-IN: GraphQL breaking-change diff; needs baseline)"
      echo "buf|buf|brew|brew install bufbuild/buf/buf  (or: https://buf.build)|bufbuild/buf/buf"
      echo "openapi-spec-validator|openapi-spec-validator|pipx|pipx install openapi-spec-validator  (OpenAPI structural validity gate)"
      echo "protolint|protolint|go|go install github.com/yoheimuta/protolint/cmd/protolint@latest||go:github.com/yoheimuta/protolint/cmd/protolint"
      ;;
    infra)
      echo "hadolint|hadolint|brew|brew install hadolint"
      echo "tflint|tflint|brew|brew install tflint"
      echo "actionlint|actionlint|brew|brew install actionlint"
      echo "zizmor|zizmor|pipx|pipx install zizmor  (OPT-IN: GitHub Actions security dataflow)"
      echo "pinact|pinact|go|go install github.com/suzuki-shunsuke/pinact/cmd/pinact@latest  (OPT-IN: pin actions to commit SHAs)||go:github.com/suzuki-shunsuke/pinact/cmd/pinact"
      echo "kube-linter|kube-linter|brew|brew install kube-linter"
      echo "kubeconform|kubeconform|brew|brew install kubeconform  (k8s manifest schema validation)"
      ;;
    docs)
      echo "markdownlint-cli2|markdownlint-cli2|npm|npm i -g markdownlint-cli2"
      echo "lychee|lychee|cargo|cargo install lychee  (or: brew install lychee)  (OPT-IN: dead-link check; network)"
      echo "cspell|cspell|npm|npm i -g cspell  (OPT-IN: offline spell-check across code + docs)"
      ;;
    *)
      return 1
      ;;
  esac
}

# ---- helpers --------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# runnable: a binary may be on PATH yet NOT actually run — most commonly a
# version-manager shim (mise/asdf) with no version selected, which dies with
# "No version is set for shim: <tool>" on every call. So `command -v` is not
# enough; smoke-test by invoking the tool. Returns 0 only if the tool both
# exists AND a trivial invocation succeeds. Hardening:
#   - stdin from /dev/null so a tool that reads stdin can't block the probe;
#   - a short timeout (timeout/gtimeout if present) so a tool that ignores
#     --version and waits can't hang the probe;
#   - try --version then --help; discard output, judge by exit status.
_TIMEOUT=""
if command -v timeout >/dev/null 2>&1; then _TIMEOUT="timeout 8"
elif command -v gtimeout >/dev/null 2>&1; then _TIMEOUT="gtimeout 8"; fi
runnable() {
  command -v "$1" >/dev/null 2>&1 || return 1
  $_TIMEOUT "$1" --version >/dev/null 2>&1 </dev/null && return 0
  $_TIMEOUT "$1" --help >/dev/null 2>&1 </dev/null && return 0
  return 1
}

field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

# mise is a universal version manager. When present (and not disabled) it is the
# preferred *installer* for tools NOT already on PATH: it pins versions and
# installs reproducibly via explicit backends (cargo:/npm:/pipx:) or its registry
# (for prebuilt binaries), with no sudo. IMPORTANT: a tool already on PATH is used
# as-is (the `have "$bin"` early-return in install_one) — we never reinstall it.
# When mise DOES install, it does so **repo-locally** (`mise use` in the current
# dir, writing ./mise.toml) — NOT `-g`, so we never mutate the user's global
# config. PREFER_MISE auto-enables if `mise` is on PATH; --no-mise clears it.
PREFER_MISE=0
have mise && PREFER_MISE=1

# Resolve which package manager command to use for an installer-key, or empty
# if none is available. We never sudo; if the manager is missing we surface the
# hint instead. When PREFER_MISE is on, cargo/npm/pipx/brew keys route through
# mise (explicit backend, or registry-by-name for the brew binaries).
manager_cmd() {
  if [ "$PREFER_MISE" -eq 1 ]; then
    case "$1" in
      cargo)     echo "mise-cargo"; return ;;
      npm)       echo "mise-npm"; return ;;
      pipx)      echo "mise-pipx"; return ;;
      go)        echo "mise-reg"; return ;;   # via go: mise-spec (field 6)
      brew)      echo "mise-reg"; return ;;  # registry binary (aqua/ubi), by name
      # npm-local stays project-local; rustup stays a toolchain component.
    esac
  fi
  case "$1" in
    brew)      if have brew; then echo "brew"; fi ;;
    pipx)      if have pipx; then echo "pipx"; elif have uv; then echo "uv-tool"; fi ;;
    npm)       if have npm; then echo "npm"; fi ;;
    npm-local) if have npm; then echo "npm-local"; fi ;;
    cargo)     if have cargo; then echo "cargo"; fi ;;
    go)        if have go; then echo "go"; fi ;;
    rustup)    if have rustup; then echo "rustup"; fi ;;
    *)         echo "" ;;
  esac
}

DRY_RUN=0
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + %s\n' "$*"
  else
    printf '  + %s\n' "$*"
    "$@"
  fi
}

# Install a single tool record. Falls back to printing the hint when no manager
# fits. js-ts/css tools are project-local; we never globally install them.
install_one() {
  rec="$1"
  name="$(field "$rec" 1)"
  bin="$(field "$rec" 2)"
  key="$(field "$rec" 3)"
  hint="$(field "$rec" 4)"

  # Optional 5th field overrides the package name passed to the manager when it
  # differs from the display/binary name (e.g. taplo's binary is `taplo` but the
  # crate is `taplo-cli`). Defaults to the display name.
  pkg="$(field "$rec" 5)"
  [ -z "$pkg" ] && pkg="$name"

  # Optional 6th field: an explicit mise tool spec (e.g. `go:github.com/...`) for
  # tools whose binary name is NOT in mise's registry, so `mise use -g <name>`
  # would fail. Used only by the mise-reg route. Falls back to the binary name.
  mise_spec="$(field "$rec" 6)"
  [ -z "$mise_spec" ] && mise_spec="$bin"

  if runnable "$bin"; then
    printf '  = %s already installed\n' "$name"
    return 0
  fi
  if have "$bin"; then
    # On PATH but not runnable — almost always a version-manager shim with no
    # version selected. Reinstalling via the resolved manager (mise route below)
    # sets a version and makes the shim work.
    printf '  ~ %s present but not runnable (shim?) — (re)installing to make it work\n' "$name"
  fi

  mgr="$(manager_cmd "$key")"
  if [ -z "$mgr" ]; then
    printf '  ! %s: no supported manager on PATH — install manually:\n      %s\n' "$name" "$hint"
    return 0
  fi

  printf '  installing %s via %s ...\n' "$name" "$mgr"
  case "$mgr" in
    brew)      run brew install "$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    pipx)      run pipx install "$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    uv-tool)   run uv tool install "$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    npm)       run npm install -g "$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    cargo)     run cargo install "$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    go)
      # Import path comes from the mise-spec field (field 6, "go:<path>"); strip
      # the prefix and pin @latest for a plain `go install`.
      go_path="${mise_spec#go:}"
      case "$go_path" in *@*) : ;; *) go_path="${go_path}@latest" ;; esac
      run go install "$go_path" || printf '      (failed — try: %s)\n' "$hint" ;;
    rustup)    run rustup component add clippy || printf '      (failed — try: %s)\n' "$hint" ;;
    # mise routes: explicit backend for source-built tools (the cargo/npm/pipx
    # package name may differ from the binary — use $pkg), registry-by-name (or an
    # explicit spec) for prebuilt binaries. `mise use` (no -g) installs + pins
    # REPO-LOCALLY, writing ./mise.toml in the current dir — never global config.
    mise-cargo) run mise use "cargo:$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    mise-npm)   run mise use "npm:$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    mise-pipx)  run mise use "pipx:$pkg" || printf '      (failed — try: %s)\n' "$hint" ;;
    mise-reg)   run mise use "$mise_spec" || printf '      (failed — try: %s)\n' "$hint" ;;
    npm-local)
      printf '  ! %s is project-local — install inside the repo, not globally:\n      %s\n' "$name" "$hint"
      ;;
  esac
}

probe_bundle() {
  b="$1"
  installed=0; missing=0; shim=0
  printf '\n[%s]\n' "$b"
  while IFS= read -r rec; do
    [ -z "$rec" ] && continue
    name="$(field "$rec" 1)"; bin="$(field "$rec" 2)"; hint="$(field "$rec" 4)"
    if runnable "$bin"; then
      printf '  ok   %s\n' "$name"
      installed=$((installed + 1))
    elif have "$bin"; then
      # On PATH but a trivial invocation fails — version-manager shim with no
      # version set, broken install, etc. Treat as NOT usable: the sniff run must
      # skip this tool (or install it), never assume it works.
      printf '  SHIM %s   — on PATH but not runnable; install to activate: %s\n' "$name" "$hint"
      shim=$((shim + 1))
    else
      printf '  MISS %s   — %s\n' "$name" "$hint"
      missing=$((missing + 1))
    fi
  done <<EOF
$(tools_for "$b")
EOF
  if [ "$shim" -gt 0 ]; then
    printf '  (%d usable, %d unrunnable/shim, %d missing)\n' "$installed" "$shim" "$missing"
  else
    printf '  (%d installed, %d missing)\n' "$installed" "$missing"
  fi
}

list_bundle() {
  b="$1"
  printf '\n[%s]\n' "$b"
  while IFS= read -r rec; do
    [ -z "$rec" ] && continue
    printf '  %-18s %s\n' "$(field "$rec" 1)" "$(field "$rec" 4)"
  done <<EOF
$(tools_for "$b")
EOF
}

install_bundle() {
  b="$1"
  if ! tools_for "$b" >/dev/null 2>&1; then
    printf 'sniff: unknown bundle "%s" (known: %s)\n' "$b" "$BUNDLES" >&2
    return 1
  fi
  printf '\n[%s]\n' "$b"
  while IFS= read -r rec; do
    [ -z "$rec" ] && continue
    install_one "$rec"
  done <<EOF
$(tools_for "$b")
EOF
}

usage() {
  cat <<'EOF'
usage: install-tools.sh [--probe | --list | --install <bundle>... | --all] [--dry-run]

  --probe              report installed/missing tools per bundle (default)
  --list               list every bundle and its tools
  --install <bundle>   install the named bundle(s): core dup security rust go
                       python js-ts shell sql css data api infra docs
  --all                install every bundle
  --dry-run            print install commands without running them
  --no-mise            ignore mise even if present; use brew/cargo/npm/pipx directly

Tools are always optional; sniff skips and warns when one is absent. Never sudo.
A tool already on PATH is used as-is (never reinstalled). When a tool is missing
and `mise` is on PATH, mise installs it REPO-LOCALLY (`mise use`, writing
./mise.toml in the current directory — not global config); pass --no-mise to use
brew/cargo/npm/pipx directly instead. Run from the repo where you want the local
  mise.toml pin. Project-local tools (eslint, knip, biome, stylelint, svelte-check,
  vue-tsc) are reported,
not installed globally — add them to the repo's own devDependencies.
EOF
}

# ---- arg parsing ----------------------------------------------------------

mode="probe"
targets=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe)   mode="probe" ;;
    --list)    mode="list" ;;
    --no-mise) PREFER_MISE=0 ;;
    --all)     mode="install"; targets="$BUNDLES" ;;
    --install) mode="install" ; shift
               while [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; do targets="$targets $1"; shift; done
               continue ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install-tools.sh: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$mode" in
  probe)
    printf 'sniff tool probe (all tools optional; missing ones are skipped, not fatal)\n'
    for b in $BUNDLES; do probe_bundle "$b"; done
    printf '\nInstall a bundle with: install-tools.sh --install <bundle>\n'
    ;;
  list)
    for b in $BUNDLES; do list_bundle "$b"; done
    ;;
  install)
    if [ -z "$targets" ]; then
      printf 'install-tools.sh: --install needs at least one bundle name\n' >&2
      usage >&2; exit 2
    fi
    [ "$DRY_RUN" -eq 1 ] && printf '(dry run — no changes will be made)\n'
    for b in $targets; do install_bundle "$b"; done
    printf '\nDone. Re-run --probe to confirm.\n'
    ;;
esac
