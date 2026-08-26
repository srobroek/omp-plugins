# Upstream routes for design-prototype

Every upstream is an entry in the `srobroek-omp` catalog, so a missing skill is one command
away, and that command is the USER's to run. OMP discovers plugins at session startup, so an
install applies from the NEXT session and never rescues the current one. Marketplace install
runs no package manager, so nothing here arrives as a dependency of `@srobroek/design`; each
is an explicit install.

| Upstream skill | Repo | Install |
|---|---|---|
| `html-wireframe` | `plannotator/effective-html` | `omp plugin install effective-html@srobroek-omp` |
| `html-prototype` | `plannotator/effective-html` | same entry |
| `frontend-slides` | `zarazhangrui/frontend-slides` | `omp plugin install frontend-slides@srobroek-omp` |
| `web-asset-generator` | `alonw0/web-asset-generator` | `omp plugin install web-asset-generator@srobroek-omp` |
| `superdesign` | `superdesigndev/superdesign-skill` | `omp plugin install superdesign@srobroek-omp` |

All five are MIT with a LICENSE file. Skill granularity is the whole plugin, so
`effective-html` also installs `html`, `design-artifact`, `html-diagram`, and `html-plan`.
The other three install one skill each, which is unusually clean.

## Routes that need no install

- `skill://wireloom` is vendored into this package, so it is always available. Its renderer
  is `npm install wireloom`, and its grammar is cited by URL rather than vendored.
- `xd://generate_image` is built in. Raster only, so no SVG and no PDF. Reference images go
  in `input`; it writes a new temp file and never mutates the input.
- `inspect_image` is built in, gated on the `modelRoles.vision` role. It yields a vision
  judgement, never a measured pixel diff, because OMP ships no pixel-diff primitive.
- The `wire-dsl` MCP server ships declared in this package's `.omp-plugin/plugin.json`. It
  is the ONLY working Wire DSL route: the upstream repository has no plugin manifest and
  its one skill-shaped file is a bare `.md`, so a catalog entry would install cleanly and
  contribute nothing. Verified empirically.
- The `excalidraw` MCP server ships in the SEPARATE `diagram` package, not this one, because
  plugin MCP tools are session-global and a diagramming canvas serves any architecture or
  flow work. Get it with `omp plugin install diagram@srobroek-omp`. Installing `design`
  alone does NOT provide it, so that row stays unreachable until you do.

MCP servers connect at session startup only. One unreachable when the session began stays
unreachable until the user runs `/mcp reconnect <name>`; an agent cannot reconnect it.

## Prerequisites and accounts

- `web-asset-generator` needs Python 3.6+ with pip and Pillow. `pilmoji` and `emoji<2.0.0`
  are optional, for emoji generation.
- `frontend-slides` needs nothing to author. PPT conversion needs Python with
  `python-pptx`; deploying needs Node.
- `superdesign` runs `npx --yes @superdesign/cli@latest` and needs an authenticated
  account, with `login` when unauthenticated. Image and video generation consumes credits.
  Confirm the account with the user before routing to it. Its free-tier limits are not
  publicly documented, so make no claim about them.
- `excalidraw` needs a client supporting MCP Apps. Its upstream declares MIT in
  `package.json` and ships no LICENSE file, so it is advertised and never vendored.
