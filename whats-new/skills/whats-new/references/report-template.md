# What's New Report Template

Fill **every** section. If a section has no findings, write "None found" plus
the sources you checked -- never leave it blank (a blank reads as "not
researched", which is different from "nothing to report"). Cite a source for
each material claim: release tag, commit SHA (short), CHANGELOG heading, feed
entry date, or doc URL.

The header line adapts to the target kind: a **version span** for software, a
**date window** for a service/stream.

```md
# What's New: <name>  <current → latest>  |  <since <date> → now>

## Summary
- One-line verdict — software: "Safe minor bump" / "Major — breaking, plan a
  migration"; service: "N notable launches since <date>, M relevant to us".
- Scope researched: <current> → <latest> (<N> releases), or window <date> → now.
- Sources used: <releases | commits | changelog | feed | API | docs>; missing: <...>.

## Breaking changes
- <change> — impact on this codebase if known. (source: <tag/SHA/url>)

## Deprecations
- <API/flag/option> deprecated in <version>, removal planned <version|unknown>.
  Replacement: <what to use instead>. (source: <...>)

## New features
- <feature> added in <version>. (source: <...>)

## Notable fixes
- <fix>, esp. security/correctness fixes relevant here. (source: <...>)

## Upgrade notes
- Migration steps the maintainers call out, required config/codemod, minimum
  runtime/toolchain bumps, ordering constraints.

## Coverage & confidence
- Which sources were available vs. missing, and where confidence is low
  (e.g. unresolved tags, no per-version release notes, heuristic commit
  classification).

## Sources
- <primary: release notes / migration guide / changelog>
- <supporting: commit ranges, docs, advisories>
```

## Notes on filling it

- Order findings within a section by impact (breaking/security first).
- For a major bump, the **Upgrade notes** and **Breaking changes** sections are
  the point -- invest there.
- If the user scoped the request ("only breaking changes", "security only"),
  still keep the headings but say "Out of scope per request" under the ones you
  skipped, so the omission is explicit.
