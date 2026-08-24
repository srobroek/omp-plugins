# Refactor-Challenger Brief Template

Use this to construct the prompt for the `refactor-challenger` agent in step 6.
The challenger's whole value comes from **isolation**: give it the findings and
the observable evidence, but NOT your reasoning, your preferred plan, or your
confidence. Let it reach its own verdict so it does not inherit your blind spots.

Spawn once over the consolidated finding set. The agent is read-only.

---

```
You are stress-testing a set of refactoring recommendations produced for this
repository. For each, decide KEEP / DOWNGRADE / DROP per your agent definition.
Bias toward pragmatism and idiom: a real but low-value or non-idiomatic-but-fine
finding should not survive as a high-priority recommendation.

## Findings under test
For each finding (facts only — verify them yourself):

- **ID:** <n>
- **Location:** <file:line>
- **Smell claimed:** <smell name>
- **Evidence:** <metric / quoted code / tool + rule id that produced it>
- **Proposed refactoring:** <refactoring + refactoring.guru technique>
- **Claimed back-compat:** <safe | breaking: surface>

<repeat per finding>

## Repo context (facts only)
- Languages: <list>
- Conventions / config: <e.g. .golangci.yml present, project uses X idiom>
- Public surfaces to protect: <published API, wire formats, config keys — if known>

## What I am NOT telling you
I am deliberately withholding which findings I think matter most and why. Reach
your own verdicts from the code.

## Return
Your Refactor Critique Report: a verdict table (KEEP/DOWNGRADE/DROP with
evidence and adjusted severity), the dropped/downgraded rationale, back-compat
hazards, confirmed strong findings, and any gaps you noticed.
```

---

## Filling guidance

- **Withhold your priors.** Do not write "I think #3 is the big one" -- that is
  exactly the framing the challenger exists to test independently.
- **Pass evidence, not conclusions.** "140 lines, ccn 22" is evidence; "this is
  clearly too complex" is a conclusion -- give the former.
- **Name the public surfaces** you know about so the challenger can judge
  back-compat accurately; it cannot always infer what is published.
- **Apply the verdicts** when it returns: DROP → remove, DOWNGRADE → lower
  priority/severity, KEEP → carry into the plan. Record drops/downgrades in the
  report's transparency section.
- For a very large finding set, you may batch by language across multiple
  challenger spawns -- but keep each batch's evidence complete.
