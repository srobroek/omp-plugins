# delivery

The delivery plugin warns when a `git push` names `main` or `master` as its destination.
It also documents pull-request review, landing proof, native isolation cleanup, and Beads linkage.

## Agents

| Name | When |
| --- | --- |
| `pr-reviewer` | Review a pull request without changing it. The agent returns `VERDICT:` only and has no shell access. |

## Rules

| Name | When |
| --- | --- |
| `delivery-git-workflow` | Create or review pull requests, run automated-review loops, prove landing, clean native isolation clones, or link delivery to Beads. |
| `delivery-main-branch-push-advisory` | A bash call names `main` or `master` as a `git push` destination. |

The advisory never blocks a command (`interruptMode: never`). It matches bash arguments as text and recognizes destinations such as `origin main`, `HEAD:main`, `refs/heads/main`, `:main`, and `+HEAD:main`.

It stays silent on bare `git push`, `git push main` (where `main` is the remote), option values such as `--force-with-lease=main`, and quoted mentions. It cannot inspect the repository, checked-out branch, remote, or server-side branch protection.

`bun test rules/` scores the condition against both encodings a live buffer carries: the bash tool's argument JSON and the bare command.

## Extensions

### `unpushed-work-advisory`

At session stop, this extension reports dirty paths it observed and unpushed commits since its repository baseline.
Path counts do not establish authorship or permission to stage or publish a file.
