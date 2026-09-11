# docs

Renders documentation scaffolding by `docs_flavour`: `splash` (Astro under `site/`), `site` (mdBook for Rust, mkdocs-material otherwise), or `none`. Always adds `docs/adr/0001-record-architecture-decisions.md` and `docs/architecture.md`, and writes `.omp/docs.json` so the CI and policy layers can detect the flavour.
