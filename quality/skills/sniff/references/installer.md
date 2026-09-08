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
   the user wants to see commands.
4. **Proceed regardless.** If the user declines an install, continue with what
   is present and list the gaps in the final report's coverage note.

## Bundles

Use `sniff_install_tools` with `{"mode":"list"}` for current bundle membership
and install commands. Bundle names: `core`, `dup`, `security`, `rust`, `go`,
`python`, `js-ts`, `shell`, `sql`, `css`, `data`, `api`, `infra`, `docs`.

After approval, for example, call with
`{"mode":"install","bundles":["infra"],"path":"<repo-root>"}`.
`{"mode":"install","bundles":["infra"],"dryRun":true}` prints commands only.
Bundle installs cover every member, including opt-ins: obtain approval for the
whole bundle or install only individually approved tools using the listed
commands. Do not use `all:true` unless all bundles were explicitly approved.

## Package managers

The native tool prefers mise when available; `noMise:true` disables that route.
Its fallback uses the tool's supported manager (`brew`, `pipx` / `uv tool`,
`npm`, `cargo`, `rustup`, or `go`). Unavailable installs are reported; never sudo.

## Project-local tools

`eslint`, `knip`, `biome`, `stylelint` are JS ecosystem tools that belong in the
**repo's own** `devDependencies`, pinned with the project. The native tool does **not**
install them globally; it reports them and prints the `npm i -D ...` line to run
inside the repo. Run them via `npx` so the project's config and plugin versions
apply.

## Rust note

`clippy` ships with the Rust toolchain (`rustup component add clippy`) and
already covers most Rust dimensions. Do not push the user to install extra Rust
tooling beyond `cargo-machete` unless they ask for a deep pass (then
`cargo-udeps`, nightly).
