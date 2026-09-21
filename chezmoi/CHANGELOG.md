# Changelog

## [0.4.11](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.10...chezmoi--v0.4.11) (2026-09-21)


### Bug Fixes

* fail closed on unavailable repository probes ([#446](https://github.com/srobroek/omp-plugins/issues/446)) ([fc30b7b](https://github.com/srobroek/omp-plugins/commit/fc30b7b984a7ea4f27385321f139da64c57f9e0f))

## [0.4.10](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.9...chezmoi--v0.4.10) (2026-09-19)


### Bug Fixes

* **plugins:** harden security-sensitive extensions ([#416](https://github.com/srobroek/omp-plugins/issues/416)) ([b7837ef](https://github.com/srobroek/omp-plugins/commit/b7837ef55c334293a1381d66fb52d207226aa694))


### Refactors

* **steering:** centralize precedence; retire delivery and delegation rules ([#408](https://github.com/srobroek/omp-plugins/issues/408)) ([5aaead3](https://github.com/srobroek/omp-plugins/commit/5aaead3483be6818c681dc8749327388b428d9a1))


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))

## [0.4.9](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.8...chezmoi--v0.4.9) (2026-09-18)


### Bug Fixes

* **chezmoi:** remove direct-main delivery guidance ([#374](https://github.com/srobroek/omp-plugins/issues/374)) ([2a3d026](https://github.com/srobroek/omp-plugins/commit/2a3d026ddca406f349d14f615d49efcd46eacc8c))

## [0.4.8](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.7...chezmoi--v0.4.8) (2026-09-16)


### Refactors

* **delivery:** replace blocking gates with push advisory ([#325](https://github.com/srobroek/omp-plugins/issues/325)) ([f65d1f5](https://github.com/srobroek/omp-plugins/commit/f65d1f5b38226a6627401a3b3ca95c26b08236a2))

## [0.4.7](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.6...chezmoi--v0.4.7) (2026-09-15)


### Bug Fixes

* **chezmoi:** align direct delivery guidance ([#295](https://github.com/srobroek/omp-plugins/issues/295)) ([ee2e33a](https://github.com/srobroek/omp-plugins/commit/ee2e33a2a7fde440d8daa81a1224ac7f20300840))

## [0.4.6](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.5...chezmoi--v0.4.6) (2026-09-15)


### Bug Fixes

* **delivery:** trust remote steering sources ([ce43658](https://github.com/srobroek/omp-plugins/commit/ce43658be90aa22656fd973b2daf05c8e0400a4e))

## [0.4.5](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.4...chezmoi--v0.4.5) (2026-09-13)


### Bug Fixes

* **delivery:** require resolved git verb in primary checkout gate ([#241](https://github.com/srobroek/omp-plugins/issues/241)) ([58977f3](https://github.com/srobroek/omp-plugins/commit/58977f39d5b4669913d45ae9c3b16b7ee5844766))

## [0.4.4](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.3...chezmoi--v0.4.4) (2026-09-11)


### Bug Fixes

* **chezmoi:** anchor the credential-word patterns instead of matching substrings ([6f064c4](https://github.com/srobroek/omp-plugins/commit/6f064c4eb52fc7d4e9c574927ea804efa2ce4252))
* **chezmoi:** anchor the credential-word patterns instead of matching substrings ([286f95e](https://github.com/srobroek/omp-plugins/commit/286f95e651ae644f86687f5a07fff0a8ab16a1f1))
* **chezmoi:** clear the design-token documentation names by exact name ([537e737](https://github.com/srobroek/omp-plugins/commit/537e7375a2507396aefccb281ce4c20de63aa797))

## [0.4.3](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.2...chezmoi--v0.4.3) (2026-09-11)


### Bug Fixes

* **chezmoi:** feed the nested-shell word test only unquoted text ([c006708](https://github.com/srobroek/omp-plugins/commit/c00670875af62817fae987b1eaefa0e97d9d526d))
* **chezmoi:** identify a nesting shell by its command word, not its neighbours ([e9c9f80](https://github.com/srobroek/omp-plugins/commit/e9c9f80e58752d4aa1a86a74e844542464ebebf1))
* **chezmoi:** refuse a commit reached through a nested shell ([11f0b38](https://github.com/srobroek/omp-plugins/commit/11f0b38ed963f61c89c28fd371ddca58c97d7f46))

## [0.4.2](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.1...chezmoi--v0.4.2) (2026-09-11)


### Bug Fixes

* repair the secret-commit guard's cwd model and the beads backend resolver ([#169](https://github.com/srobroek/omp-plugins/issues/169)) ([d8c3c85](https://github.com/srobroek/omp-plugins/commit/d8c3c8520e9b8a96aafe1f42505af49bd31cd370))

## [0.4.1](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.4.0...chezmoi--v0.4.1) (2026-09-11)


### Bug Fixes

* **chezmoi:** satisfy the repository TypeScript and lint contract ([fd4fcaf](https://github.com/srobroek/omp-plugins/commit/fd4fcaffd0584f02a04875f22565b44ef5f5a7b5))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.3.1...chezmoi--v0.4.0) (2026-09-10)


### Features

* **chezmoi:** deliver dotfiles directly to main ([#142](https://github.com/srobroek/omp-plugins/issues/142)) ([6b1b616](https://github.com/srobroek/omp-plugins/commit/6b1b6167a88fe3bfad1204f43685f22af3efda46))

## [0.3.1](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.3.0...chezmoi--v0.3.1) (2026-09-08)


### Bug Fixes

* **chezmoi:** inspect actual commit candidates in the effective context ([0873e6b](https://github.com/srobroek/omp-plugins/commit/0873e6b6d12ebacafebb01a228f76de18e79ccef))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))


### Documentation

* clarify plugin safety and usage contracts ([f147fba](https://github.com/srobroek/omp-plugins/commit/f147fbaa08ddae1f5d745defd613b2d33ece4d61))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.2.0...chezmoi--v0.3.0) (2026-08-25)


### Features

* **authoring,chezmoi:** lint reminder, repomix TTSR, secret commit gate ([90b8c58](https://github.com/srobroek/omp-plugins/commit/90b8c5817c69c845282a04e042be60c2b2992136))
* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/chezmoi--v0.1.0...chezmoi--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
