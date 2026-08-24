# Review-bot rounds

A review bot (CodeRabbit by default) posts its findings on the PR minutes after
the PR is published, outside every status check the merge decision already
reads. This file is the shepherd's side of that wait: probe it, wait on it
without polling, and route actionable findings to the coder that owns the code.

## Which bots

`$PR_REVIEW_BOTS` is a comma-separated list of bot slugs; the default is
`coderabbitai`. A slug matches a check by name or details URL and a review or
review comment by `<slug>[bot]` author. An unconfigured bot is invisible: the
probe reports `absent` and the merge decision is unchanged, which keeps this
contract inert in repositories with no review bot.

Adding a bot has two parts, and only the first is required:

1. Add its slug to `$PR_REVIEW_BOTS`. Its check and review presence become
   visible immediately, so a running check waits and a `CHANGES_REQUESTED`
   verdict bounces.
2. Add an adapter to `ADAPTERS` in `scripts/bot-review-probe.py` so its
   finding count is read too. Without one, a `COMMENTED` round reports
   `pending` rather than guessing — safe, but it never clears on its own.
   `bot-review-probe.py bots` prints which configured slugs have an adapter.

An adapter is a slug, a body-to-count function, and a note. Most bots need one
regex, so `_regex_count(r"...(?P<n>\d+)")` is usually the whole entry. This is
why the probe is Python: the per-bot part is a data table, not a parser.

## Probe

Two calls, because the fetch is the only part that needs the network:

```bash
scripts/bot-review-probe.py fetch <repo> <pr> >"$snapshot"
scripts/bot-review-probe.py classify <head_sha> <"$snapshot"
```

`classify` is pure, so a stored snapshot reclassifies identically. It exits with
the same vocabulary as the rest of the contract:

| Exit | State | Meaning |
|---:|---|---|
| 0 | `absent` | no configured bot on this PR; merge decision unchanged |
| 0 | `clean` | the bot's latest round at this head posted 0 actionable comments |
| 10 | `pending` | the check is running, or completed with no review at this head yet |
| 11 | `stale` | the bot reviewed an older head only |
| 12 | `actionable` | the latest round at this head has actionable comments |
| 13 | `declined` | the bot refused the round on quota or rate limit; re-trigger, do not wait |
| 2 | unknown | malformed or unreadable evidence |

Actionability comes from the bot's own summary review through its adapter. For
CodeRabbit that body carries `Actionable comments posted: N`; every fix
suggestion hangs under that summary, so `N` is the signal and nothing else is —
a long nitpick-only body with `N=0` merges. A `CHANGES_REQUESTED` verdict is
actionable for any bot, adapter or not.

Read the LATEST summary at the head, never the highest count. The bot re-reviews
after a push and after resolution; a `max` would let a resolved round block the
PR forever.

`pending`, `stale`, and unknown are all not-yet-mergeable. A completed bot check
with no review at the exact head is a wait: silence is not approval.

`declined` is the state no further round ends on its own: the bot refused this
round under its quota or rate limit, so it must be re-triggered once the window
reopens. `wait=` carries that reopen instant, computed from the notice's post
time plus the figure the bot gave, because the figure decays from the moment it
is posted. `wait=UNKNOWN` means no figure was readable, so re-check the PR
instead of re-triggering.

A refusal notice does not expire out of the PR's comment history, so the probe
reads it last. A review at the probed head decides the state by its count, a
review at an older head only reads `stale`, and a running check still reads
`pending`; a notice from an earlier commit cannot mask any of them.

## Waiting without polling

The wait is owned by a gate, not by your session, exactly as CI is. When the
probe returns `pending` or `stale`:

1. Attach a gate to the merge bead only for a concrete run id:
   `bd gate create --type=gh:run --blocks <merge-bead> --await-id <run-id>`
   using the bot check's run id when the check is a GitHub Actions run. A bot
   posting through the Checks API has no run id; in that case attach no gate.
2. Stamp `bot_review_state` and `bot_review_head` on the merge bead so the next
   pass can tell a fresh wait from a repeat.
3. Comment the observed state once per `<state>@<head>` pair, release the claim,
   and continue the drain. `bd gate check --type=gh` plus the next pass own the
   wait.

Never re-poll in-session, never sleep, and never hold the merge slot across a
bot wait.

## Routing actionable findings

An actionable round is a bounce, on the same path as CI-red and conflicts, so
the merge bead parks behind one unassigned `agent:coder` fix bead and lands only
after that bead closes. It is a durable bead, not a wisp: it blocks a merge
through a dependency edge, and a burned wisp would take that edge with it.

Generate the key from the round's identity so repeat passes reconcile instead of
filing duplicates:

```bash
scripts/landing-contract.py failure-key <repo> review "bot:<slug>@<head_sha>"
scripts/landing-contract.py ensure-bounce <merge-bead> <key> agent:coder \
  <title> <metadata-json> <description>
```

Keying on the head means a new push produces a new round and a new fix bead
rather than reopening a closed one.

The fix bead carries POINTERS, not a copy of the findings:

- the summary review URL and each bot comment's `path:line` and URL, from the
  probe's `COMMENT` lines;
- `bot`, `bot_review_head`, `pr`, `repo`, `branch`, and
  `failure=bot-review` in metadata;
- the instruction to read the bot's comments on the PR directly and apply the
  changes that are correct and appropriate, replying on the PR to any it
  rejects with the reason.

Pointers, not copies, for three reasons: the bot's thread is live and gets
resolved, replied to, and superseded as the coder works, so a copy goes stale
the moment it is written; the findings carry diff suggestions that only render
on the PR; and copying a full review round into a bead is exactly the content
bloat the shepherd's context budget forbids.

The shepherd never decides whether a finding is right. It routes the round and
stops. The coder claiming the fix bead judges each comment, applies what holds,
rejects what does not with a reply on the PR, and closes the fix bead — which
re-readies the merge bead for the next pass and a fresh bot round at the new
head.
