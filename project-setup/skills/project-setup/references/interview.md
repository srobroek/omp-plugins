# Interview mechanics

How a question is chosen, asked, and recorded. The topic references say what to ask;
this says how.

## Confirming prior instruction

The command arguments and the conversation before it arrive as claims, not answers. A
claim the user has not confirmed in this conversation is a gap.

Read them back once, numbered, as `<claim> -- right?`, and group them:

| Source of the claim | Status until confirmed |
|---|---|
| The user stated it in this conversation | STRONG, and no confirmation is needed |
| A reference derives it from something STRONG | STRONG |
| The command arguments assert it | CLAIM, read it back |
| Recalled memory, a stored preference, a past project | RECOMMENDATION, never a claim |
| A tool lookup, such as the logged-in forge account | RECOMMENDATION |

MUST Offer a RECOMMENDATION as the default inside its question. What a user often picks
stays theirs to pick, and recording one as decided removes the question without asking it.

## Asking a topic

A topic opens when every one of its prerequisites is settled. Inside it:

1. List every question whose own prerequisites are settled. That list is the frontier.
2. Number them, and carry a recommended answer on each, so `1, 2, 4 yes` accepts three
   and leaves one open.
3. Ask them as one message. A question the topic's reference marks derived or fixed is
   not asked at all.
4. A question whose answer decides which other questions exist is a frontier of exactly
   itself. An either/or between two mutually exclusive tool choices is such a question,
   and the winner's own settings open in the next round.
5. Re-list the frontier after each round. An answer can add questions that did not exist
   before it.
6. The topic's frontier is empty → read the topic's answers back as a table and ask the
   user to accept or revise it.

## Accepting and revising a topic

ASK `Accept this topic, or name what to change?`

| Reply | Effect |
|---|---|
| Accept | The topic's answers become STRONG, and the next topic opens |
| A change inside the topic | Re-ask that question and every question it gated, then re-read the topic back |
| A change to an accepted topic | Reopen that topic, then re-read every later topic whose answers depended on it |

NOT Reopening an accepted topic without saying which later answers it invalidates.

## Secrets

A value matching one of these shapes never reaches a file: `ghp_`, `gho_`, `sk-`,
`AKIA`, `ASIA`, `glpat-`, `xox[baprs]-`, or a PEM header line.

MUST Refuse the write, say that the credential now sits in a transcript and has to be
rotated, and leave that setting a gap. The variable's name and what breaks without it
belong in `docs/agents/env/index.md`; the value belongs in the environment or a secret
manager.

## What is never derived

- The licence. Recommend one with its tradeoff and let the user choose.
- Publishing a repository, and its visibility.
- A marketplace, registry, or plugin source. Naming one is a supply-chain decision, and
  registration is machine-global.
- A credential, or where one is stored.
