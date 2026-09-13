# Changelog

## [1.1.3](https://github.com/srobroek/omp-plugins/compare/quality--v1.1.2...quality--v1.1.3) (2026-09-13)


### Refactors

* **architecture:** apply the languages audit ([#251](https://github.com/srobroek/omp-plugins/issues/251)) ([be355d7](https://github.com/srobroek/omp-plugins/commit/be355d7c19c0d690d5637c4afd31ff143ba5b9ab))

## [1.1.2](https://github.com/srobroek/omp-plugins/compare/quality--v1.1.1...quality--v1.1.2) (2026-09-12)


### Refactors

* **quality:** remove embedded Sniff implementation ([#223](https://github.com/srobroek/omp-plugins/issues/223)) ([e94d500](https://github.com/srobroek/omp-plugins/commit/e94d500d866393f3c7017b300d2ef86fa3d3a5af))

## [1.1.1](https://github.com/srobroek/omp-plugins/compare/quality--v1.1.0...quality--v1.1.1) (2026-09-11)


### Bug Fixes

* **quality:** assert hosted analyzer plugins never become runtime tools ([07f6a0c](https://github.com/srobroek/omp-plugins/commit/07f6a0c1db0e8584ddd2678073e8b3f8dc97c7bf))
* **quality:** reduce sniff skill density ([b8fb294](https://github.com/srobroek/omp-plugins/commit/b8fb294ec8cac4b2a3a9629e1431d54a25d003f8))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [1.1.0](https://github.com/srobroek/omp-plugins/compare/quality--v1.0.0...quality--v1.1.0) (2026-09-10)


### Features

* **quality:** enforce atomic sniff analyzer runs ([3ff021a](https://github.com/srobroek/omp-plugins/commit/3ff021ae99f434eda69e80ea0166163301884e07))
* **quality:** enforce atomic sniff analyzer runs ([94efed5](https://github.com/srobroek/omp-plugins/commit/94efed5a1364fc3173429df9b1419b8a9370229f))

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/quality--v0.6.1...quality--v1.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* Drop support for APM formats and sidecar agent contracts.

### Features

* retire APM formats and add staged lint ([#68](https://github.com/srobroek/omp-plugins/issues/68)) ([07996f1](https://github.com/srobroek/omp-plugins/commit/07996f115baddbe4261ce6892100238bff2310bd))


### Refactors

* retire redundant agents and repair role routing ([#66](https://github.com/srobroek/omp-plugins/issues/66)) ([1a8dbb2](https://github.com/srobroek/omp-plugins/commit/1a8dbb24f127dfcbacb624857459a36a918ca4e6))

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/quality--v0.6.0...quality--v0.6.1) (2026-09-08)


### Bug Fixes

* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **verification:** report missing checks and use installed toolchains ([58ce78a](https://github.com/srobroek/omp-plugins/commit/58ce78a4c86f855182c10bcb1a7aa1a6a8c8c563))


### Documentation

* clarify plugin safety and usage contracts ([f147fba](https://github.com/srobroek/omp-plugins/commit/f147fbaa08ddae1f5d745defd613b2d33ece4d61))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/quality--v0.5.2...quality--v0.6.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))

## [0.5.2](https://github.com/srobroek/omp-plugins/compare/quality--v0.5.1...quality--v0.5.2) (2026-08-25)


### Bug Fixes

* **quality:** move bloodhound off the duplicate [@architect](https://github.com/architect) role ([#37](https://github.com/srobroek/omp-plugins/issues/37)) ([7c722dd](https://github.com/srobroek/omp-plugins/commit/7c722ddadb6d118686678a70b5e8b87e71adaa04))

## [0.5.1](https://github.com/srobroek/omp-plugins/compare/quality--v0.5.0...quality--v0.5.1) (2026-08-25)


### Bug Fixes

* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([76caeec](https://github.com/srobroek/omp-plugins/commit/76caeec135b0b1943b6df551578cd6b6e7facd1b))
* **ttsr:** audit wave - loosen the advisory rules and move canonicalize to clippy ([72d5cd1](https://github.com/srobroek/omp-plugins/commit/72d5cd15d167c21a8a153012af2acec7c0362309))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/quality--v0.4.0...quality--v0.5.0) (2026-08-25)


### Features

* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/quality--v0.3.0...quality--v0.4.0) (2026-08-25)


### Features

* **rules:** mechanize nine steering clauses as TTSR rules ([539efc0](https://github.com/srobroek/omp-plugins/commit/539efc02a153a2fddeab8d4bd2fee6ada30e7040))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/quality--v0.2.0...quality--v0.3.0) (2026-08-25)


### Features

* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/quality--v0.1.0...quality--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
