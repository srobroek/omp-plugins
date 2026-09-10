# Installer Flow

How sniff handles tool availability. The contract: **tools are always optional,
never auto-installed, never sudo.** Missing tools become reported coverage gaps,
not errors.

The tool `sniff_install_tools` does the mechanical work; this doc is the
agent's playbook for using it.

## First-run / step-2 sequence

1. **Probe.** `sniff_install_tools` with mode `probe`. It prints, per bundle, which
   tools are installed and which are missing (with an install hint each).
2. **Propose the full set; the user deselects.** Do not dump raw probe output
   and ask "install all?", and do not offer depth tiers (lean/full/custom) --
   that is the blocking-checkpoint violation `workflow.md` Step 2 forbids: every
   viable tool for the detected stack is pre-selected **default-on**; the user
   trims, they don't opt in. Present a decision shaped like:

   ```
   Detected stack: Go, TypeScript, Dockerfile, GitHub Actions
   Installed:        golangci-lint ✓  eslint ✓
   Missing (default-on): semgrep ✗  hadolint ✗  actionlint ✗
   Opt-in (off unless requested): jscpd ✗ — redundant with golangci-lint's dupl
     for Go; only adds value for TS, where eslint+sonarjs already cover
     duplication
   ```
   Pull the overlap/gap facts from `references/tooling.md`.
3. **Install every default-on tool the user doesn't deselect.**
   `sniff_install_tools` mode `install` with `bundles` or `all`. Use `dryRun` first if
   the user wants to see commands. Install success is provisional: the tool re-probes
   every command in a fresh mise-aware environment and reports a failure unless the
   command is usable there. Never bypass package trust policy.
4. **Run through the analyzer wrapper.** Installation never authorizes a later scan.
   Invoke each selected analyzer with `sniff_run_analyzer`; it performs that tool's
   preflight immediately before execution. A non-usable result blocks only that run
   and becomes a coverage gap with status, resolved path, and remediation.

## Bundles

Bundles group installation/catalog entries by target family. They are not analyzer
manifests and never authorize execution. Use `sniff_install_tools` mode `list` for
the canonical membership; do not duplicate that generated inventory here.

## Package managers

The native tool prefers mise when available; `noMise:true` disables that route.
Its fallback uses the tool's supported manager (`brew`, `pipx` / `uv tool`,
`npm`, `cargo`, `rustup`, or `go`). Unavailable installs are reported; never sudo.

## Project-local tools

JS ecosystem analyzers belong in the repo's `devDependencies`. The installer reports
the required package set but does not install it globally. `sniff_run_analyzer`
resolves these executables only from the target's `node_modules/.bin`.

## Rust note

`clippy` ships with the Rust toolchain (`rustup component add clippy`) and
already covers most Rust dimensions. Do not push the user to install extra Rust
tooling beyond `cargo-machete` unless they ask for a deep pass (then
`cargo-udeps`, nightly).
