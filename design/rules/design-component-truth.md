---
name: design-component-truth
description: When using component props or Storybook stories, verify each prop against the component documentation before coding.

---

Prop hallucination is its own failure mode. A plausible-sounding prop such as
`shadow`, `size`, or `variant` compiles in a loose codebase, renders nothing, and passes
review because the name reads correct. No token, slop, or evidence rule catches it. Where
a Storybook exists, it publishes the ground truth.

MUST Verify a prop against documentation before using it, including one whose name reads as certain.
MUST Read `http://localhost:6006/manifests/components.json` when it serves, then index `components` by id and select the engine-specific payload based on `meta.docgen`. The key is not the engine string: engine `react-docgen` puts its payload under `reactDocgen`, whose `props` carry `required`, a `tsType`, and a `description`.
MUST Use the Storybook MCP `list-all-documentation` then `get-documentation` instead when that server is connected.
MUST Fetch `get-storybook-story-instructions`, or read the project's existing stories, before writing or updating a story.
DEFAULT Check the work with the project's existing story test route: the Vitest addon where the project runs it, `run-story-tests` when the MCP is connected, otherwise `npx --yes --package=@storybook/test-runner test-storybook`. Pass `--package`: an unrelated `test-storybook` package exists on npm.
NOT Infer a prop from a naming convention or from another library's API. Two component libraries agreeing on a name is a coincidence, not a contract.
NOT Trust a story name to reflect a prop name. Verify through the manifest, the ArgTypes block, or an example snippet.
NOT Pass a prop no documentation names. Return the question to whoever holds the conversation: a subagent returns it to its caller and never asks the user. Inventing one ships dead markup.

| situation | where prop truth comes from |
|---|---|
| `manifests/components.json` serves | `components[<id>].reactDocgen.props` |
| that route 404s, or no Storybook exists | the component source and its type declaration |
| a Storybook exists but is not React | the rendered Autodocs `ArgTypes` block, or the source |
| the prop is absent wherever you looked | do not pass it; return the question to the conversation owner |

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
