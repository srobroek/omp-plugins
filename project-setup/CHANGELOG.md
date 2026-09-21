# Changelog

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/project-setup--v0.2.0...project-setup--v0.3.0) (2026-09-21)


### Features

* **project-setup:** accessibility and internationalisation assets ([#452](https://github.com/srobroek/omp-plugins/issues/452)) ([199222b](https://github.com/srobroek/omp-plugins/commit/199222be936f78db0ebd9af5bda291d8a7e4073f))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/project-setup--v0.1.0...project-setup--v0.2.0) (2026-09-21)


### Features

* **project-setup:** replace scaffold runtime ([#436](https://github.com/srobroek/omp-plugins/issues/436)) ([f8fd91b](https://github.com/srobroek/omp-plugins/commit/f8fd91b75ec57d667a209ba68c771a04c0501464))


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))

## 0.1.0

### Features

* the `/project-setup` command, the only entry point into the setup workflow
* the `project-setup` skill: GREENFIELD and BROWNFIELD classification, prior-instruction
  confirmation, repository and deployable classification, host settled before any stack,
  per-topic question frontiers with topic-level acceptance, an exact plan, and an explicit
  apply gate
* eleven progressive references covering interview mechanics, application shape,
  repository and hosting, the TypeScript, Python, Rust, and Go stacks, protocols and
  events, delivery and tooling, the asset library, and verification
* a static asset library: baseline repository files, Worktrunk configuration, the Just task
  surface, prek hook fragments, per-language quality and CI fragments, an OpenAPI contract
  set, the CI composition workflows, and the `docs/agents/` steering tree
* pinact 5.0.0 in the CI mise fragment so the quality workflow's SHA-pin check has a binary
* `pull-requests: read` on the generated `changes` job and `wc-changes.yml` so
  dorny/paths-filter can read the pull-request files API
* OSV scan failure preserved: the SARIF upload still runs, but `continue-on-error` is gone
* `install_agents_index.py --agents` for a brownfield `AGENTS.md` symlink; the installer
  never writes through the link
