---
name: design-upstream-preflight
description: Before a design skill, agent, or formula routes to an upstream skill or CLI, install and probe only what that route needs.
---

# Design Upstream Preflight

Run this when a design skill, agent, or formula is loaded, before its first routed step.
Check only the rows the current route reaches. The `design` package bundles none of these;
each comes from its upstream author.

| Routed name | Upstream repo | Marketplace | Install address | Prerequisite probe | Needed when |
|---|---|---|---|---|---|
| `impeccable` skill; `impeccable detect` CLI | `pbakaus/impeccable` | `impeccable` | `impeccable@impeccable` | `npx --version` | design workflow; critique steps run the CLI |
| `ss-lint`, `ss-review`, `ss-tokens`, `ss-score`, `ss-motion` | `bitjaru/styleseed` | `styleseed` | `styleseed@styleseed` | `node --version` | `design-system-audit` StyleSeed route, only after the user opts in; `motion-design` React `motion.X` authoring |
| `accessibility` | `addyosmani/web-quality-skills` | `addy-web-quality-skills` | `web-quality-skills@addy-web-quality-skills` | none | `accessibility-audit` |
| `html-wireframe`, `html-prototype` | `plannotator/effective-html` | `effective-html` | `plannotator-effective-html@effective-html` | `python3 --version` to serve | `design-prototype` |
| `frontend-slides` | `zarazhangrui/frontend-slides` | `frontend-slides` | `frontend-slides@frontend-slides` | `python-pptx`, only for PPT conversion | `design-prototype` deck row |
| `web-asset-generator` | `alonw0/web-asset-generator` | `web-asset-generator-marketplace` | `web-asset-generator@web-asset-generator-marketplace` | `Pillow` | `design-prototype` asset row |
| `superdesign` | `superdesigndev/superdesign-skill` | `superdesign` | `superdesign@superdesign` | authenticated account with credits | `design-prototype` hosted row, after the user confirms |
| `create-design-md` | `ibelick/ui-skills` | `srobroek-omp` | `ui-skills@srobroek-omp` | none | `design-md` |

The `create-design-md` row installs through the `srobroek-omp` catalog because its upstream
ships no marketplace or plugin manifest.

## Procedure

1. List installed plugins. -> `omp plugin list --json`; a row is installed when its install
   address appears as a `.marketplace[].id`.
2. Install each missing row the route needs. -> `omp plugin marketplace list` names the
   marketplace, or `omp plugin marketplace add OWNER/REPO` registers it; then
   `omp plugin install ADDRESS`.
3. Probe each prerequisite. -> the probe exits zero. Python packages: run
   `python3 -c 'import PIL'` or `python3 -c 'import pptx'`; on failure run the upstream
   script through `uv run --no-project --with pillow python SCRIPT` or
   `--with python-pptx`. With no `uv`, STOP and report the missing prerequisite.
4. Load the routed skill. -> a skill in your available skills loads via `skill://`. One
   installed this session does not: `skill://` resolves only plugins discovered at
   session start. Resolve its path with
   `omp plugin list --json | jq -r '.marketplace[] | select(.id=="ADDRESS") | .entries[0].installPath'`,
   then `find INSTALLPATH -path '*/skills/NAME/SKILL.md'`, and read that file.
5. Report each install, its path, and any prerequisite still missing. -> the user knows
   the skill becomes native next session.

## Rules

MUST Install only the rows in the table, from the listed repo and address.
MUST STOP and report when an install or probe fails. Never substitute your own guidance
  for the routed upstream.
ASK Before adding the `superdesign` marketplace or installing it: it needs an account and
  spends credits.
NOT Install a row the current route does not reach.
NOT Install a Python package globally with `pip`.
