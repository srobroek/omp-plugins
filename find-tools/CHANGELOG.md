# Changelog

## [1.0.1](https://github.com/srobroek/omp-plugins/compare/find-tools--v1.0.0...find-tools--v1.0.1) (2026-09-11)


### Bug Fixes

* **find-tools:** separate discovery stderr with real newlines ([4dd4109](https://github.com/srobroek/omp-plugins/commit/4dd410942e880da7aa75aa24f611107e741c09c6))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/find-tools--v0.4.1...find-tools--v1.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* Drop support for APM formats and sidecar agent contracts.

### Features

* retire APM formats and add staged lint ([#68](https://github.com/srobroek/omp-plugins/issues/68)) ([07996f1](https://github.com/srobroek/omp-plugins/commit/07996f115baddbe4261ce6892100238bff2310bd))

## [0.4.1](https://github.com/srobroek/omp-plugins/compare/find-tools--v0.4.0...find-tools--v0.4.1) (2026-09-08)


### Bug Fixes

* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **discovery:** bound scans and report incomplete research ([c74117e](https://github.com/srobroek/omp-plugins/commit/c74117e13b2d0228afb750ea1b63ed4e62512dfe))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/find-tools--v0.3.1...find-tools--v0.4.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))

## [0.3.1](https://github.com/srobroek/omp-plugins/compare/find-tools--v0.3.0...find-tools--v0.3.1) (2026-08-25)


### Bug Fixes

* **ttsr:** audit wave - loosen the advisory rules and move canonicalize to clippy ([72d5cd1](https://github.com/srobroek/omp-plugins/commit/72d5cd15d167c21a8a153012af2acec7c0362309))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/find-tools--v0.2.0...find-tools--v0.3.0) (2026-08-25)


### Features

* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/find-tools--v0.1.0...find-tools--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
* work the migration backlog — speckit and project-setup plugins, TTSR adoptions, discovery tools ([90cae47](https://github.com/srobroek/omp-plugins/commit/90cae47f11df265138b099dcf1825daa14a22da0))
