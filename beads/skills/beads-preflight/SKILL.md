---
name: beads-preflight
description: Runs read-only Beads readiness checks before ledger work. Use when starting ledger work or asking for a beads preflight.
---

# Beads preflight

TRIGGER
+ Before starting ledger work in a session
+ "run the beads preflight"
- Worktrunk or orchestrate readiness → run that component's preflight

## Workflow

1. Before ledger work starts in the session, run:
   `python3 skills/beads-preflight/preflight.py --json`
2. Read the JSON object. `ok` is `true` when no check has `status: "fail"`.
3. `warn` and `skip` do not clear `ok`.
   Each check has a stable `id`.
   Each check has a status, detail, and optional exact `fix` command.
4. Select checks with `--only ID[,ID...]`.
   Use `--apply` to print that no Beads check has a safe automatic fix.
5. The `no-stale-lease-on-open-work` scan is skipped by default because it enumerates open beads. Pass `--include-slow`, or select that ID explicitly with `--only`, to run it.
6. Every `bd` call has a five-second timeout by default. Override it with `--timeout SECONDS`; a timeout is reported as `warn`, except a `store-reachable` timeout is `fail`.

This skill is read-only.
It performs no ledger mutation.


## Check failures and remedies

| ID | FAIL means | Exact remedy |
| --- | --- | --- |
| `bd-available` | `bd` is not on PATH. The version command failed. | Install stable `bd`. Expose it with `export PATH='DIRECTORY_CONTAINING_BD:$PATH'`. |
| `bd-version-supported` | The client is older than stable `1.3.0`. The client is an RC or prerelease. | Put stable `bd` version `1.3.0` or later first on PATH. |
| `store-reachable` | `bd info --json` failed. The result was not an object. `config.issue_prefix` was missing. | Repair the store reported by `bd info --json`. |
| `store-is-embedded` | The embedded `.beads` store was not confirmed. | Configure the checkout to use its embedded `.beads` store. A server configuration is a `warn`, not a required shared server. |
| `actor-identity` | Neither actor environment variable is non-blank. | Run `export BEADS_ACTOR='your-name'`. |
| `ready-work-readable` | `bd ready --json` failed. Its JSON was unparseable or unknown-shaped. | Repair the Beads store. Run `bd ready --json`. |
| `no-stale-lease-on-open-work` | The verified JSON lease scan could not run. Its result could not be parsed. | Run `bd unclaim ID` for each stale assigned bead. |
| `remote-sync-configured` | This check never fails. | A `skip` means `bd dolt remote list` could not determine the setting read-only. |

A stale lease is a `warn`, never a failure. The script never runs `bd unclaim` or any synchronization command.
