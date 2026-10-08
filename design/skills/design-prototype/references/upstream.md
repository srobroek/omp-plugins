# Upstream routes for design-prototype

Each upstream installs from its author's marketplace through
`rule://design-upstream-preflight`, when the chosen row needs it. Nothing here arrives
as a dependency of `@srobroek/design`.

| Upstream skill | Repo | Install |
|---|---|---|
| `html-wireframe` | `plannotator/effective-html` | `plannotator-effective-html@effective-html`, via `rule://design-upstream-preflight` |
| `html-prototype` | `plannotator/effective-html` | same entry |
| `frontend-slides` | `zarazhangrui/frontend-slides` | `frontend-slides@frontend-slides`, via `rule://design-upstream-preflight` |
| `web-asset-generator` | `alonw0/web-asset-generator` | `web-asset-generator@web-asset-generator-marketplace`, via `rule://design-upstream-preflight` |
| `superdesign` | `superdesigndev/superdesign-skill` | `superdesign@superdesign`, via `rule://design-upstream-preflight` |

All five are MIT with a LICENSE file. Skill granularity is the whole plugin, so
`effective-html` also installs `html`, `design-artifact`, `html-diagram`, and `html-plan`.
The other three install one skill each, which is unusually clean.

## Routes that need no install

- `skill://wireloom` is vendored into this package, so it is always available. Its renderer
  is the unversioned `npm install wireloom`, and its grammar is read from the upstream
  `main` URL rather than vendored, so both follow the current release.
- `xd://generate_image` is built in. Raster only, so no SVG and no PDF. Reference images go
  in `input`; it writes a new temp file and never mutates the input.
- `inspect_image` is built in, gated on the `modelRoles.vision` role. It yields a vision
  judgement, never a measurement. The measured pixel diff is the browser's
  `tab.diffScreenshot(baselinePath, {threshold})`.
- The `wire-dsl` MCP server ships declared in this package's `.omp-plugin/plugin.json`. It
  is the ONLY working Wire DSL route: the upstream repository has no plugin manifest and
  its one skill-shaped file is a bare `.md`, so a catalog entry would install cleanly and
  contribute nothing. Verified empirically.

## Prerequisites and accounts

- `web-asset-generator` needs Python 3.6+ with pip and Pillow. `pilmoji` and `emoji<2.0.0`
  are optional, for emoji generation.
- `frontend-slides` needs nothing to author. PPT conversion needs Python with
  `python-pptx`; deploying needs Node.
- `superdesign` runs `npx --yes @superdesign/cli@latest` and needs an authenticated
  account, with `login` when unauthenticated. Image and video generation consumes credits.
  Confirm the account with the user before routing to it. Its free-tier limits are not
  publicly documented, so make no claim about them.
