# github

Applies repository policy through the GitHub API; renders no files except the opt-in `CLA.md`.
`scaffold.py policy apply --root . --dry-run` prints the requests, and the plain command sends
only the ones whose current value differs. `docs/repository-policy.md` lists what it applies and
what a maintainer still does by hand.
