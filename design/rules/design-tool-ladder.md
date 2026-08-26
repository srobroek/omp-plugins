---
name: design-tool-ladder
description: Which verification tool to use at each design phase, and what evidence each produces. Read before driving a surface.
---

OMP lists every rule by name and description in the domain-rules block, so this file is
addressable without being resident. It carries no `globs` and no `alwaysApply`: the agent
reads it on demand, because it is the longest rule here and applies to a phase rather than
to a file type.

MUST Pick the tool from the phase table. A tool outside its phase is a miss.
MUST Check at COMPONENT level before page level. A component-level failure is smaller to
  locate than the same failure found on an assembled page, and page-first work is the
  named Component Driven anti-pattern.

| phase | tool | evidence | failure it prevents |
|---|---|---|---|
| GROUND | `read` / `grep` / `ast_grep` | token names, scales, 5-10 existing primitives | inventing a token that already exists |
| SPECIFY | `read` DESIGN.md | resolved `{group.token}` refs, Known Gaps | writing TODO / inventing unknowns |
| BUILD | `lsp` rename; `read` / `ast_grep` | every state implemented | text-rename dropping a callsite |
| VERIFY | `browser` (web) or `computer` (native) | ARIA snapshot, then computed style, then screenshot | claiming a surface without driving it |
| CRITIQUE | `browser` / `computer` read-only | named finding + evidence path | visual opinion with no snapshot |
| RECONCILE | same tool as the failing assertion | re-run of that assertion only | re-running the whole suite after a one-line fix |

MUST Discover tokens and primitives with `read`, `grep`, or `ast_grep` before writing a value.
MUST Drive a web surface with `browser`. Drive a native desktop surface with `computer`.
MUST Collect evidence in this order: `tab.ariaSnapshot()` then `tab.evaluate` (computed styles) then `tab.screenshot({selector,fullPage})`.
MUST Rename a token or component with `lsp` rename. A text substitution that touches a symbol is a miss.
NOT Treat a screenshot as an explanation. A screenshot answers appearance only and cannot say why something fails.
NOT Use screenshot diffing as primary evidence.
NOT Skip ARIA when the surface has an accessibility tree.
