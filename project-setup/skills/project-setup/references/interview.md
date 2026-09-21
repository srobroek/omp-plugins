# Interview mechanics

How a question is chosen, asked, and recorded. The topic references say what to ask;
this says how.

## Confirming prior instruction

Command arguments arrive as claims. A claim that the user has not confirmed is a gap. Direct user
statements in this conversation are settled answers; read them back once without asking again.

Read command claims back once, numbered, as `<claim> -- right?`, and group them:

| Source of the claim | Status until confirmed |
|---|---|
| The user stated it in this conversation | STRONG, and no confirmation is needed |
| A reference derives it from something STRONG | STRONG |
| The command arguments assert it | CLAIM, read it back |
| Recalled memory, a stored preference, a past project | RECOMMENDATION, never a claim |
| A tool lookup, such as the logged-in forge account | RECOMMENDATION |

MUST Offer a RECOMMENDATION as the default inside its question. What a user often picks stays theirs
to pick, and recording one as decided removes the question without asking it.
EXCEPT A supply-chain source question has no recommendation when the global gate requires a
user-supplied source. Label it `USER INPUT REQUIRED`.

## Choice cardinality

DEFAULT Use multi-selection when two or more options can coexist in one accepted design. Use
single-selection only when accepting one option makes every other option invalid; state that
exclusivity invariant in the question's reference.

MUST Make multi-select options atomic. Do not offer `Multiple`, `A + B`, or another compound option;
the selected set represents the combination.
MUST Treat `None` as exclusive with every positive option. If a positive option and `None` are both
selected, re-ask rather than guessing which answer wins.
MUST Open the union of follow-up questions required by all selected options.
NOT Use single-selection because one option is recommended, common, or simpler.

## Asking a topic

A topic opens when every one of its prerequisites is settled. Inside it:

1. List every question whose own prerequisites are settled. That list is the frontier.
2. Number them and label one proposed value `RECOMMENDED — UNACCEPTED`, so
   `1, 2, 4 yes` accepts three and leaves one open.
3. Ask them as one message. A question the topic's reference marks derived or fixed is not asked.
   A recommendation never removes its question and never becomes an answer without a user reply.
4. A question whose answer decides which other questions exist is a frontier of exactly itself. An
   either/or between two mutually exclusive tool choices is such a question, and the winner's own
   settings open in the next round.
5. Re-list the frontier after each round. An answer can add questions that did not exist before it.
6. `Accept topic recommendations` accepts every currently unaccepted recommendation in that topic,
   then opens any follow-up questions implied by those answers. It is never inferred from silence.
7. The frontier is empty only when every setting is `USER`, `ACCEPTED_RECOMMENDATION`, `DERIVED`,
   `FIXED`, or `ACCEPTED_GAP`. A `RECOMMENDED — UNACCEPTED` or `GAP` row keeps it open.
8. `ACCEPTED_GAP` means the user explicitly accepted a named unsupported capability and its
   consequence. It permits planning but never permits a claim that the capability works.
9. Read the settled topic back as `Setting | Value | Source`, then ask the user to accept or revise
   it. Use one of the five settled statuses as Source.

Before accepting a topic, derive every affected ADR draft from its settled answers. Derive the title
and decision from the accepted setting, the rationale from its accepted driver, alternatives from
the rejected options, consequences from the tradeoffs shown, and confirmation from the planned
verification. Show those ADR rows in the settled-topic readback. Any field that cannot be derived is
an unblocked frontier question. A topic is not accepted until its ADR rows are accepted.

## Accepting and revising a topic

ASK `Accept this settled topic, or name what to change?`

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
