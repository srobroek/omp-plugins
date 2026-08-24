# License Decision Matrix

## Input → Output mapping

Match the user's answers to Phase 1-2 questions against this matrix.
First match wins (most specific first).

### Templates / scaffolding (any ecosystem)

→ **Apache-2.0** (or MIT)

Rationale: copyleft on template files contaminates generated user projects.
The output of a template tool must be unencumbered. No exceptions -- even if
the user "wants copyleft", explain the output contamination problem first.

If the user insists on protecting the template ENGINE: suggest a split license
(engine under MPL-2.0, template content under MIT-0 or CC0) and note this
requires clear directory-level LICENSE separation.

### Config / prompts / thin-copyright content

→ **Apache-2.0**

Rationale: uncertain copyrightability. A court may not treat prompts or config
as protectable expression. The license is a values signal, not an enforceable
shield. Copyleft here adds friction for zero real protection.

### Library + Rust/C/embedded + no substitutes + wants reciprocity

→ **MPL-2.0**

Rationale: file-level copyleft is the strongest that doesn't trigger
substitute-avoidance. Works with static linking (file boundary, not binary
boundary). Patent grant in §2.1. GPL-compatible by default (§3.3).

### Library + Rust/C/embedded + has substitutes + wants adoption

→ **Apache-2.0**

Rationale: when drop-in alternatives exist, any copyleft (even weak) diverts
users to substitutes. Adoption is the contribution funnel; optimize for it.

### Library + Python/TypeScript/Go + no substitutes + wants reciprocity

→ **MPL-2.0**

Same logic as Rust. LGPL would also work in Python (no linking concept) but
MPL is simpler and ecosystem-agnostic.

### Library + any + wants max adoption + no reciprocity concern

→ **Apache-2.0** (prefer over MIT for the patent grant)

### Application + SaaS-wrappable + wants fork/wrap protection

→ **AGPL-3.0-only**

Rationale: GPL's network loophole lets someone host with private mods. AGPL §13
closes it. Zero adoption cost (nobody links against an app). Blanket corporate
bans are the product working as designed (their "adoption" IS the threat).

### Application + distribution-only risk (hostile forks)

→ **GPL-3.0-only**

Rationale: fork must stay open when distributed. Less aggressive than AGPL
(no network clause), fewer blanket bans for tools people just run.

### Application + wants upstream absorption into permissive project

→ Match the upstream license (usually MIT or Apache-2.0)

Rationale: copyleft forecloses the merge path. If the win condition is your
code landing in someone else's MIT/Apache project, you must be license-
compatible as an inbound contribution.

### Application + no specific threat + hobbyist project

→ **Apache-2.0** (status quo default) or **GPL-3.0** (if principle matters)

Present both; let the user decide based on whether they'd be sad seeing a
closed fork vs. whether they value simplicity.

### Dual commercial licensing desired

→ Whatever copyleft license fits above, PLUS:
- CLA from day one (required to sell commercial licenses of the combined work)
- CONTRIBUTING.md stating the CLA requirement
- CLA bot (contributor-assistant/github-action)

Note: the stronger the copyleft, the more "pain" → the more commercial value.
AGPL + commercial license is the proven model (Grafana, MongoDB pre-SSPL, Minio).
MPL + commercial license is nearly unpurchasable (MPL is too easy to comply with).
