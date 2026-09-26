# Changelog

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/build--v0.6.2...build--v1.0.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* orchestrate agents no longer list or call `hub`; the wait-discipline extension is removed; build no longer ships operator; agent output schemas replace `status`/`loop_result` with `verdict`.

### Features

* cut orchestrate over to OMP 18.3 and finish its capability contracts ([fd5831e](https://github.com/srobroek/omp-plugins/commit/fd5831e2ff96ea18950c6809cb98cf93f8888ce1))


### Bug Fixes

* **build:** constrain external worker checkout ([#551](https://github.com/srobroek/omp-plugins/issues/551)) ([192984a](https://github.com/srobroek/omp-plugins/commit/192984a9cc79430140c477161f020e3811b07c01))

## [0.6.2](https://github.com/srobroek/omp-plugins/compare/build--v0.6.1...build--v0.6.2) (2026-09-19)


### Refactors

* **steering:** centralize precedence; retire delivery and delegation rules ([#408](https://github.com/srobroek/omp-plugins/issues/408)) ([5aaead3](https://github.com/srobroek/omp-plugins/commit/5aaead3483be6818c681dc8749327388b428d9a1))


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/build--v0.6.0...build--v0.6.1) (2026-09-16)


### Refactors

* **build:** enforce recursive work-conserving task delegation ([#327](https://github.com/srobroek/omp-plugins/issues/327)) ([90621cc](https://github.com/srobroek/omp-plugins/commit/90621cc6bef46fee6624cadc72545d9a58d516c8))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/build--v0.5.0...build--v0.6.0) (2026-09-16)


### Features

* **architecture:** add read-only architect agent definition ([#308](https://github.com/srobroek/omp-plugins/issues/308)) ([268d30b](https://github.com/srobroek/omp-plugins/commit/268d30ba4e63b102b2435f13408ecfe16983af19))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/build--v0.4.0...build--v0.5.0) (2026-09-15)


### Features

* **build:** scope direct-edit prose changes ([#296](https://github.com/srobroek/omp-plugins/issues/296)) ([b7dc4f3](https://github.com/srobroek/omp-plugins/commit/b7dc4f33aa05c5dbeb42744f14759d121054f83a))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/build--v0.3.4...build--v0.4.0) (2026-09-14)


### Features

* **build:** route main tasks through low-cost agents ([#259](https://github.com/srobroek/omp-plugins/issues/259)) ([e6239a8](https://github.com/srobroek/omp-plugins/commit/e6239a86d4040d5f5569b0b66ab2a684bde29b87))


### Bug Fixes

* **build:** delegate before repository tool calls ([#262](https://github.com/srobroek/omp-plugins/issues/262)) ([dc83aaf](https://github.com/srobroek/omp-plugins/commit/dc83aaf25885a652d7d35708089404524e74551c))

## [0.3.4](https://github.com/srobroek/omp-plugins/compare/build--v0.3.3...build--v0.3.4) (2026-09-11)


### Bug Fixes

* **authoring:** enforce agent metadata parity ([19ad6ae](https://github.com/srobroek/omp-plugins/commit/19ad6aeeb78038f74c0901bc5630c5f818c021d5))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [0.3.3](https://github.com/srobroek/omp-plugins/compare/build--v0.3.2...build--v0.3.3) (2026-09-08)


### Refactors

* retire redundant agents and repair role routing ([#66](https://github.com/srobroek/omp-plugins/issues/66)) ([1a8dbb2](https://github.com/srobroek/omp-plugins/commit/1a8dbb24f127dfcbacb624857459a36a918ca4e6))

## [0.3.2](https://github.com/srobroek/omp-plugins/compare/build--v0.3.1...build--v0.3.2) (2026-09-08)


### Bug Fixes

* **agents:** route operator to smol and PR reviewer to task ([#62](https://github.com/srobroek/omp-plugins/issues/62)) ([e2e2972](https://github.com/srobroek/omp-plugins/commit/e2e29728771251a8e838f2f1b9b560a832b61307))

## [0.3.1](https://github.com/srobroek/omp-plugins/compare/build--v0.3.0...build--v0.3.1) (2026-09-08)


### Bug Fixes

* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))


### Refactors

* **workflows:** remove forced handoffs and clarify capability ownership ([3ce7513](https://github.com/srobroek/omp-plugins/commit/3ce751337ad10128cac01535fe8779ea83899885))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/build--v0.2.0...build--v0.3.0) (2026-08-25)


### Features

* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/build--v0.1.0...build--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
