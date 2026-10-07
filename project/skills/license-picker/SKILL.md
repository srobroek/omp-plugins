---
name: license-picker
description: Selects an OSI-approved license from project constraints and explains implementation tradeoffs. Use for new repositories, relicensing, or “what license should I use?”
---

# License Picker

Interactive license selection: structured questions, an OSI-approved recommendation grounded in the user's constraints, and implementation steps.

## Triggers

- "What license should I use", "pick/choose a license", "license this"
- New open-source repo without a license, or relicensing/license migration
- A quick factual question about license mechanics, per-file headers, or CLA setup (skip the interview; LOAD skill://license-picker/references/framework.md and answer directly)

## Workflow

### Phase 1: Classify the project

Ask the user with structured choices when the host supports them; otherwise ask
these questions in a normal conversational turn:

1. **Project type** -- library/dependency, application/tool, template/scaffolding,
   config/prompts, or framework?
2. **Language/ecosystem** -- Rust, Python, TypeScript, Go, C/embedded, other?
   (This determines linking model and ecosystem conventions.)
3. **Distribution model** -- published package (crates.io/PyPI/npm), standalone
   binary, SaaS/hosted, or source-only?

### Phase 2: Establish the threat model

Ask (these determine copyleft strength):

4. **What bothers you?** (multi-select)
   - Someone forking and shipping a closed competitor
   - Companies using your code without sharing bug fixes
   - Someone wrapping it as a paid hosted service
   - None of the above -- just want attribution
   - Unsure / want to understand options

5. **Substitutability** -- are there drop-in alternatives to your project that
   someone could use instead of accepting your license terms?

6. **Commercial goals** -- do you want to keep dual commercial licensing as an
   option? (This determines whether you need relicensing rights to every
   contribution, for example through a CLA.)

### Phase 3: Recommend

Based on answers, LOAD skill://license-picker/references/decision-matrix.md and follow the decision
logic. Present:

- The recommended license with SPDX identifier
- One-paragraph plain-language explanation of what it does
- The concrete tradeoffs (what you gain, what it costs)
- Any runner-up alternatives and why they're weaker for this case

**Push back** if the user's stated principle contradicts their stated constraints
(e.g., "I want reciprocity" + "I want zero friction" -- those conflict; surface
it). LOAD skill://license-picker/references/common-contradictions.md for named contradiction patterns.

### Phase 4: Validate

Before finalizing:

1. Verify the SPDX identifier exists at https://spdx.org/licenses/
2. If the project is Rust, Go, or embedded and LGPL is a candidate: flag that
   static linking obliges you to ship the application's object code or source
   so users can relink, plus any required installation information
   (LGPL-3.0 §4(d)(0), §4(e)); prefer MPL-2.0
3. If templates/scaffolding: warn about output contamination if copyleft selected
4. Check ecosystem norms -- LOAD skill://license-picker/references/ecosystem-norms.md and validate the recommendation against the relevant language section

### Phase 5: Implement

Offer to execute (with user confirmation):

1. Fetch canonical license text (from SPDX or official source)
2. Write LICENSE file
3. Update manifest (Cargo.toml / pyproject.toml / package.json) license field
4. Add per-file headers if required by the license (MPL: notice in each file, or in a LICENSE file in the relevant directory when per-file placement is impractical; GPL/AGPL: recommended; Apache/MIT: no)
5. If copyleft + commercial option: set up the chosen relicensing-rights path (CLA.md + CLA bot workflow, or copyright assignment) and state it in CONTRIBUTING.md
6. Update README with license badge and one-liner explanation

## Rules

- Only recommend OSI-approved licenses. If the user asks about SSPL, BSL,
  Elastic, or similar: explain they are source-available but NOT open-source per
  OSI, and offer the nearest OSI equivalent.
- Never recommend a license without explaining what it concretely does and what
  it costs. No "just use MIT" without rationale.
- Always surface contradictions between stated goals rather than silently picking
  a compromise.
- Validate against real constraints (static linking, dynamic linkers, ecosystem
  conventions) -- prefer MPL over LGPL for Rust, Go, and embedded.
- If the user already has a license and asks about changing: check for external
  contributors first (git log for non-bot/non-owner authors). If present, warn
  about consent requirements.
- LOAD skill://license-picker/references/decision-matrix.md for consistency -- don't freeform the recommendation.
