# Open-Source License Selection Framework

When choosing a license for a new repo or evaluating a relicense, use this
decision framework. It applies to OSI-approved licenses only.

## Decision tree

```
Is this a library consumed as a dependency?
├─ YES → Are there drop-in substitutes?
│  ├─ YES (commodity) → Apache-2.0 (minimize friction, win on merit)
│  └─ NO (niche/irreplaceable) → MPL-2.0 (reciprocity is free when users can't route around)
│
├─ Is this an application (CLI, desktop, server)?
│  ├─ Is SaaS-wrapping plausible? → AGPL-3.0-only
│  └─ Distribution-only risk (hostile forks) → GPL-3.0
│
├─ Is this a template/scaffolding tool?
│  └─ Apache-2.0 or MIT (copyleft leaks into generated output)
│
├─ Is this config/prompts/thin-copyright content?
│  └─ Apache-2.0 (enforcement is impractical; license is a values signal)
│
└─ Is the goal upstream absorption into a permissive project?
   └─ Match the upstream license (usually MIT or Apache-2.0)
```

## License comparison (OSI-approved, relevant subset)

| License | Boundary | What must be shared | Key tradeoff |
|---|---|---|---|
| MIT / Apache-2.0 | None | Nothing (attribution only) | Max adoption, zero reciprocity |
| MPL-2.0 | File | Modified source files | Reciprocity without ecosystem friction |
| LGPL-3.0 | Library (linking) | Library modifications + relink capability | Static linking (Rust, Go, embedded) means shipping relinkable object code or source (§4(d)(0)) |
| GPL-3.0 | Process | Entire derived program when distributed | Fork protection; kills library adoption |
| AGPL-3.0 | Network | Same as GPL + network service counts | SaaS protection; blanket corporate bans |

## Key principles

1. **Copyleft strength should match the threat model, not the principle.**
   "People should contribute" is a value; the license is a mechanism. Match the
   mechanism to the concrete scenario (hostile fork? proprietary patching? SaaS
   wrap?), not to the abstract principle.

2. **Friction only matters where substitutes exist.** MPL on a commodity crate
   loses to MIT alternatives. MPL on a niche crate with no substitutes costs
   nothing -- users accept it because rewriting is harder than the allowlist edit.

3. **Copyleft on applications is nearly free.** Nobody links against a CLI tool;
   the license doesn't affect users who just run it. Fork protection costs zero
   adoption.

4. **Copyleft on templates is actively harmful.** Template output inherits the
   template's license headers. Copyleft on template files punishes your own
   users' generated projects.

5. **LGPL is a trap in non-C ecosystems.** Without a shared library, compliance
   means shipping the application's object code or source so users can relink
   (§4(d)(0)); monomorphization blurs the library boundary. Use MPL instead --
   same reciprocity, language-agnostic file boundary.

6. **Apache-2.0 ≠ MIT.** Apache adds a patent grant and retaliation clause. For
   libraries where patent risk exists, prefer Apache over MIT. MPL-2.0 also has
   a patent grant (§2.1).

7. **Relicensing is a one-way door after external contributions.** Tightening
   (permissive → copyleft) is possible while sole author. After external PRs
   land without a CLA or copyright assignment, loosening or dual-licensing
   requires contributor consent or rewriting their contributions.

## CLA considerations

- Needed only to keep dual commercial licensing cheap: you need relicensing
  rights to every contribution, which a CLA or copyright assignment secures up
  front; otherwise you need later contributor consent or a rewrite
- Mechanism: CLA Assistant GitHub Action or equivalent sign-off bot
- One-time per contributor, covers all future PRs
- Only needed on copyleft repos (permissive inbound=outbound is sufficient for Apache/MIT)
- Add CONTRIBUTING.md stating the requirement before the first external PR lands

## Per-file headers

- **MPL-2.0**: Exhibit A notice in each source file, or, where per-file placement is impractical, in a location such as a LICENSE file in the relevant directory
- **GPL/AGPL**: convention, not requirement, but recommended (SPDX one-liner: `SPDX-License-Identifier: AGPL-3.0-only`)
- **Apache-2.0**: not required (LICENSE + NOTICE at repo root suffices)
- **MIT**: not required

## Cargo/Python/Node manifest fields

Always set the `license` field to the exact SPDX identifier:
- `license = "MPL-2.0"` (Cargo.toml)
- `license = "AGPL-3.0-only"` (pyproject.toml; PEP 639 SPDX expression -- the `{ text = ... }` table form is deprecated)
- `"license": "Apache-2.0"` (package.json)

For workspaces, set it in `[workspace.package]` and use `license.workspace = true` in members.
