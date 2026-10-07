# Labeling rubric

Fill `label` and `reaction` in `labels.csv`. Short codes are accepted. Leave
`label` empty to drop a row from the precision table.

## label

| Code | Label | Use when the note… |
|---|---|---|
| U | useful | is valid, arrived while it could still change the outcome, and names an action |
| P | partial | is partly valid, or valid but unverifiable from the excerpt |
| ST | stale | was true when written but already handled or moot when delivered (`turns_ago`, `next_1`) |
| DUP | duplicate | repeats the root cause of an earlier note (`dup_score` ≥ 0.3 is a hint, not proof) |
| FP | false-positive | misreads the transcript, contradicts an explicit authorization, or fires on a never-fire case |
| N | no-finding | carries no finding: acknowledgements, `DEFECT: none`, placeholders |

Substantive = every label except N. Strict precision = U / substantive; inclusive
adds P. Weighted strict reweights each stratum by its `stratum_population`.

## reaction

| Code | Reaction | Use when the next one or two primary messages (`next_1`, `next_2`)… |
|---|---|---|
| A | acted | change course, fix, or verify because of the note |
| D | dismissed | rebut or ignore the note while continuing |
| NS | never-seen | do not exist: the user spoke next or the session ended (`no_further_turn`) |

## Rules

MUST Grade stale and duplicate notes against precision; a correct note that cannot
  change the outcome is not useful.
MUST Record the reason for every FP in `comment`.
