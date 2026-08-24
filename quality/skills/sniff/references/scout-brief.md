# Bloodhound Brief Template

Use this to construct the prompt for each `bloodhound` agent spawned in step 4 --
one per language slice in the fan-out plan (a language may be split across
several hounds by subtree). Fill every field. Pass **facts only**: the language,
the scope, the handed Step-3 findings, and the language-doc path. Do not pass
your own hypotheses about what is wrong -- bloodhound finds independently.

Spawn the hounds in parallel (single message, multiple Agent calls) per the
fan-out plan from workflow.md Step 4 -- one per language as the floor, but a large
language is split across several hounds by subtree/crate/dir, each with its own
narrowed Scope. The agent is read-only.

---

```
You are scanning the **<LANGUAGE>** code in this repository for code smells.

## Scope
- Files / directories: <the resolved target file list for this language — explicit
  paths from step 0.5, NOT "the whole repo" when the run is scoped>
- Working directory: <repo root, OR the worktree path for a commit/PR/branch target>
- Exclude: <generated, vendored, test fixtures — if any>
- Scoped-run note: <if this is a diff/PR/module run, tell the agent to apply tool
  analysis-class rules — skip global-class tools (dead code/cycles) and say so>
- Base ref (if any): <for diff/PR/range — pass so baseline tools can compare>

## Static-analysis findings ALREADY RUN (do not re-run these tools)
<paste this language's Step-3 tool findings — tool, rule id, file:line, message.
These were run config-correctly in Step 3; your job is to VERIFY/contextualize
them and add the reading-layer smells tools can't see, NOT to re-run clippy/ruff/
eslint (that wastes a compile and may use a different, config-blind invocation).>

## Tools to run YOURSELF (only if Step 3 did NOT cover them here)
<usually EMPTY. List a tool + exact invocation only when Step 3 skipped it for
this language — e.g. quick mode, or a tool available only inside the worktree.
Otherwise omit this section; the findings above are your tool input.>
Tools neither handed above nor listed here are NOT available — record them as
coverage gaps, do not attempt to run them.

## Your reference
Read the **absolute path** to `references/languages/<LANGUAGE>.md` supplied in
this Brief, under the installed sniff skill directory, FIRST. It is your smell
checklist, idiom guide, and tool-invocation source. Do not resolve that path from
the target repository's working directory or improvise the catalog.

## Project conventions
- Config files governing this language: <e.g. .golangci.yml, pyproject.toml>
- Respect them; do not override project config.

## Return
Structured findings in the Bloodhound Findings format from your agent definition:
a coverage block (tools run / skipped / scope) and a findings table — every row
with file:line, smell, source, evidence, idiomatic alternative, and the
refactoring.guru smell name when one applies. Do not prioritize or fix; return
raw findings.
```

---

## Filling guidance

- **One language per hound is the floor, not the cap.** Go + TS + Dockerfile is
  three hounds; a large single language (29k-LOC Rust) is several hounds split by
  subtree/crate, each with its own narrowed Scope. Follow the Step-4 fan-out plan.
- **Hand findings, don't re-run.** Each Brief carries that slice's Step-3 tool
  findings (config-correct); the hound verifies + adds the reading layer. Only
  populate "Tools to run YOURSELF" when Step 3 did not cover a tool for this
  language -- and if you do, tell the hound to confirm availability with
  `command -v` / `runnable` and prefer ground truth (a `SHIM` counts as missing),
  so a stale list doesn't silently drop a smell dimension.
- **Scope tightly.** Pass real paths, not "the whole repo" -- for a split language,
  the specific subtree this hound owns. Keeps the scan focused and findings
  locatable, and stops two hounds covering the same files.
