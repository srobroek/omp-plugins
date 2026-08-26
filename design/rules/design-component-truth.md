---
name: design-component-truth
description: Verify a component's props against its documentation before use; never infer a prop from a naming convention.
globs: ["**/*.{tsx,jsx,ts,js,vue,svelte,astro,mdx}"]
---

Prop hallucination is its own failure mode. A plausible-sounding prop such as
`shadow`, `size`, or `variant` compiles in a loose codebase, renders nothing, and passes
review because the name reads correct. No token, slop, or evidence rule catches it. Where
a Storybook exists, it publishes the ground truth.

MUST Verify a prop against documentation before using it, including one whose name reads as certain.
MUST Read `http://localhost:6006/manifests/components.json` when it serves, then index `components` by id and select the engine-specific payload based on `meta.docgen`. The key is not the engine string: engine `react-docgen` puts its payload under `reactDocgen`, whose `props` carry `required`, a `tsType`, and a `description`.
MUST Use the Storybook MCP `list-all-documentation` then `get-documentation` instead when that server is connected.
MUST Fetch `get-storybook-story-instructions`, or read the project's existing stories, before writing or updating a story.
MUST Check the work with `npx --yes --package=@storybook/test-runner test-storybook`, or `run-story-tests` when the MCP is connected. Pass `--package`: an unrelated `test-storybook` package exists on npm.
NOT Infer a prop from a naming convention or from another library's API. Two component libraries agreeing on a name is a coincidence, not a contract.
NOT Trust a story name to reflect a prop name. Verify through the manifest, the ArgTypes block, or an example snippet.
ASK the user when a needed prop is undocumented. Inventing one ships dead markup.

| situation | where prop truth comes from |
|---|---|
| `manifests/components.json` serves | `components[<id>].reactDocgen.props` |
| that route 404s, or no Storybook exists | the component source and its type declaration |
| a Storybook exists but is not React | the rendered Autodocs `ArgTypes` block, or the source |
| the prop is absent wherever you looked | ASK; do not pass it |

The prop-table manifest is React-only in practice, measured on Storybook 10.5.10 with
`@storybook/addon-mcp` installed in both a React and a Vue project: React serves it, Vue
returns `Manifest "components" not found`. `manifests/docs.json` serves on both. `ArgTypes`
is supported in all ten frameworks Storybook documents, which makes it the cross-framework
fallback.

Three packages share the work, verified in each package's `dist/preset.js`:
`@storybook/addon-mcp` sets the `features.componentsManifest` flag, `@storybook/react`
generates the components payload, and `@storybook/addon-docs` generates the docs manifest.
A framework package that generates no payload leaves the route absent even with the flag on.

An empty `components` map is inconclusive rather than empty-by-fact: under
`features.experimentalDocgenServer` the generator returns an empty map by design.
