# Approval gates

Target resolution, stack detection, configuration reads, and read-only availability probes are allowed before tool-set approval. Do not install tools, run substantive scans, or dispatch a `bloodhound` until target and tool-set approval are established.

1. **Target.** If unnamed, ask first for the kind: whole repo, language/area, directory/module, files, uncommitted changes, commit, range/branch, or PR. Then ask for the required path/ref. Kinds compose. Never assume whole repo.
2. **Install set.** After stack detection, use `sniff_install_tools` `probe` and target references to present every viable analyzer. Default-on tools start selected; opt-in tools start unselected with their reason. Wait before install.

For a **non-interactive** run, use the target and installed tool set explicitly authorized by the user or delegated brief; record gaps and never install tools. Missing scope or tool-set authorization remains blocked; unavailability is not consent.

This SKILL is a router. Load the referenced file for each step; do not inline its content.

## Skill directory and target directory

Tools run with cwd set to the target repository, while shipped assets live under `skill://sniff/`, including `references/semgrep-rules/`. Read them through `skill://sniff/<path>`. When a tool needs a filesystem path, resolve the installed skill directory once and pass an absolute path.
