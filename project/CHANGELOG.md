# Changelog

## [1.1.2](https://github.com/srobroek/omp-plugins/compare/project--v1.1.1...project--v1.1.2) (2026-09-11)


### Bug Fixes

* repair the journeys symlink guard and the session-commit test's git isolation ([#172](https://github.com/srobroek/omp-plugins/issues/172)) ([c9ccd43](https://github.com/srobroek/omp-plugins/commit/c9ccd4353ebabfcc87ebb93aab67f429fcfb8b64))

## [1.1.1](https://github.com/srobroek/omp-plugins/compare/project--v1.1.0...project--v1.1.1) (2026-09-11)


### Bug Fixes

* **authoring:** enforce agent metadata parity ([19ad6ae](https://github.com/srobroek/omp-plugins/commit/19ad6aeeb78038f74c0901bc5630c5f818c021d5))
* **project:** reject unterminated frontmatter and skipped journey results again ([ebadbea](https://github.com/srobroek/omp-plugins/commit/ebadbeaefd640fbc4872bb741e3586555fc00dbc))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [1.1.0](https://github.com/srobroek/omp-plugins/compare/project--v1.0.0...project--v1.1.0) (2026-09-09)


### Features

* **agentic-scaffold:** formula-driven scaffold plugin; move it out of project ([8f71d19](https://github.com/srobroek/omp-plugins/commit/8f71d19d4703214ae0352117305e48d3f95f2528))

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/project--v0.4.0...project--v1.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* Drop support for APM formats and sidecar agent contracts.

### Features

* retire APM formats and add staged lint ([#68](https://github.com/srobroek/omp-plugins/issues/68)) ([07996f1](https://github.com/srobroek/omp-plugins/commit/07996f115baddbe4261ce6892100238bff2310bd))


### Refactors

* retire redundant agents and repair role routing ([#66](https://github.com/srobroek/omp-plugins/issues/66)) ([1a8dbb2](https://github.com/srobroek/omp-plugins/commit/1a8dbb24f127dfcbacb624857459a36a918ca4e6))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/project--v0.3.1...project--v0.4.0) (2026-09-08)


### Features

* **project:** add agentic scaffolding and repository context hooks ([#64](https://github.com/srobroek/omp-plugins/issues/64)) ([974536d](https://github.com/srobroek/omp-plugins/commit/974536df3e3c75d6d4f9128b6477c2eb9412cf86))

## [0.3.1](https://github.com/srobroek/omp-plugins/compare/project--v0.3.0...project--v0.3.1) (2026-09-08)


### Bug Fixes

* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **project:** bind consolidation and pruning to approved journeys ([1e2d95d](https://github.com/srobroek/omp-plugins/commit/1e2d95df04c351a2ce4e14ca74861402c5df7f4d))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/project--v0.2.0...project--v0.3.0) (2026-08-25)


### Features

* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/project--v0.1.0...project--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
