# Changelog

## [0.6.3](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.6.2...dep-update--v0.6.3) (2026-09-11)


### Bug Fixes

* **dep-update,whats-new:** rebuild the bundles with the toolchain CI uses ([d1cdad4](https://github.com/srobroek/omp-plugins/commit/d1cdad42267750583c56c6f285188682d8404a73))
* **dep-update:** order the imports I added in lib.ts ([41bb23e](https://github.com/srobroek/omp-plugins/commit/41bb23e2d93c576054fdb8998d7e4cbb9797b528))


### Refactors

* **dep-update,whats-new:** give the duplicated detector one owner per plugin and a drift check ([d8be096](https://github.com/srobroek/omp-plugins/commit/d8be096c505992d6d38f47ddf4901f4b46673469))
* **dep-update,whats-new:** give the duplicated detector one owner per plugin and a drift check ([023cdfe](https://github.com/srobroek/omp-plugins/commit/023cdfe701129839bc1c12b79a6fb7d60f27a880))

## [0.6.2](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.6.1...dep-update--v0.6.2) (2026-09-11)


### Bug Fixes

* **dep-update:** recognise a whitespace-padded pinned package manager ([65aa7f8](https://github.com/srobroek/omp-plugins/commit/65aa7f80bdada4fbee144736333d6fb52271ece7))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.6.0...dep-update--v0.6.1) (2026-09-08)


### Bug Fixes

* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **dep-update:** classify numeric equality pins by their versions ([f9ec250](https://github.com/srobroek/omp-plugins/commit/f9ec250f3190851a84522596215be71d09a6d49a))
* **dep-update:** exclude unresolved versions from upgrade plans ([e6b814d](https://github.com/srobroek/omp-plugins/commit/e6b814d25e9fa6741211f163c31891264f8af781))
* **dep-update:** reject unresolved numeric ranges ([86bd557](https://github.com/srobroek/omp-plugins/commit/86bd55725d8b446dd8eac6da64e4d109e63f8dea))
* **discovery:** bound scans and report incomplete research ([c74117e](https://github.com/srobroek/omp-plugins/commit/c74117e13b2d0228afb750ea1b63ed4e62512dfe))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.5.1...dep-update--v0.6.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))

## [0.5.1](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.5.0...dep-update--v0.5.1) (2026-08-25)


### Bug Fixes

* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([76caeec](https://github.com/srobroek/omp-plugins/commit/76caeec135b0b1943b6df551578cd6b6e7facd1b))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.4.0...dep-update--v0.5.0) (2026-08-25)


### Features

* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.3.0...dep-update--v0.4.0) (2026-08-25)


### Features

* **rules:** mechanize nine steering clauses as TTSR rules ([539efc0](https://github.com/srobroek/omp-plugins/commit/539efc02a153a2fddeab8d4bd2fee6ada30e7040))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.2.0...dep-update--v0.3.0) (2026-08-25)


### Features

* **dep-update,whats-new:** hard gates for fixture writes and report-only ([1796bac](https://github.com/srobroek/omp-plugins/commit/1796bac1de663a9750d0928eca08f6f65a166af9))
* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))


### Bug Fixes

* **deps:** update dependency smol-toml to v1.8.0 ([#4](https://github.com/srobroek/omp-plugins/issues/4)) ([cde53d1](https://github.com/srobroek/omp-plugins/commit/cde53d131766e4d4cfdb69e985a8e496a0363d6b))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/dep-update--v0.1.0...dep-update--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
