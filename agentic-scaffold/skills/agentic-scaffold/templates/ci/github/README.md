# ci/github

Renders `.github/workflows/ci.yml` and `.github/renovate.json` to the standard in
`docs/ci-standard.md`. The workflow has:

- a lane for each language layer the interview selected; lanes run in parallel
- a `hooks` lane, an `agentic` lane, and a `security` lane
- a `gate` job that needs every lane, always runs, and fails on anything but success

Branch protection needs the `gate` check and nothing else. Every action reference carries a
commit SHA with the version in a trailing comment; Renovate moves both together.
