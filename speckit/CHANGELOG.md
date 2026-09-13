# Changelog

## [0.7.2](https://github.com/srobroek/omp-plugins/compare/speckit--v0.7.1...speckit--v0.7.2) (2026-09-13)


### Refactors

* **beads:** apply the rules audit ([#252](https://github.com/srobroek/omp-plugins/issues/252)) ([129a5f8](https://github.com/srobroek/omp-plugins/commit/129a5f8e972f89abe35e1985394363f5ede37670))
* **design:** apply the productivity audit ([#250](https://github.com/srobroek/omp-plugins/issues/250)) ([940eb98](https://github.com/srobroek/omp-plugins/commit/940eb9841ac38fc5399f36602113f778ca90f524))

## [0.7.1](https://github.com/srobroek/omp-plugins/compare/speckit--v0.7.0...speckit--v0.7.1) (2026-09-11)


### Bug Fixes

* **authoring:** enforce agent metadata parity ([19ad6ae](https://github.com/srobroek/omp-plugins/commit/19ad6aeeb78038f74c0901bc5630c5f818c021d5))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))
* **speckit:** propagate setup failures at tool boundary ([7add27d](https://github.com/srobroek/omp-plugins/commit/7add27d06dc553565328abbc4334a6cf8747b18e))
* **speckit:** restore tasks.md blocking for write and edit calls ([98a2fc7](https://github.com/srobroek/omp-plugins/commit/98a2fc72c5eaae086fb23b3dee57f37883674538))

## [0.7.0](https://github.com/srobroek/omp-plugins/compare/speckit--v0.6.1...speckit--v0.7.0) (2026-09-09)


### Features

* **speckit:** carry PRs through automated review remediation ([e7f5757](https://github.com/srobroek/omp-plugins/commit/e7f575755b3035b2f77dec558ae6ae647c4631c6))

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/speckit--v0.6.0...speckit--v0.6.1) (2026-09-08)


### Bug Fixes

* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **speckit:** preserve implement parents and explicit gate consent ([025ebc7](https://github.com/srobroek/omp-plugins/commit/025ebc7d98e7dcfc3ecbecae444c8cf6f4233901))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/speckit--v0.5.4...speckit--v0.6.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))

## [0.5.4](https://github.com/srobroek/omp-plugins/compare/speckit--v0.5.3...speckit--v0.5.4) (2026-08-25)


### Bug Fixes

* **speckit:** +c is not command-string mode ([3f31edf](https://github.com/srobroek/omp-plugins/commit/3f31edf9110b82e4633b4cf9efab613795675706))
* **speckit:** resolve child-shell -c scripts in the command-slot resolver ([fe9603f](https://github.com/srobroek/omp-plugins/commit/fe9603fc66e8bf9180ae580991e147496dc9dbed))
* **speckit:** resolve child-shell -c scripts in the command-slot resolver ([113bba9](https://github.com/srobroek/omp-plugins/commit/113bba909ee85ab569867fc84dbff3873e4b7f34))

## [0.5.3](https://github.com/srobroek/omp-plugins/compare/speckit--v0.5.2...speckit--v0.5.3) (2026-08-25)


### Bug Fixes

* **speckit:** model wrapper long options in the command-slot resolver ([323e1d6](https://github.com/srobroek/omp-plugins/commit/323e1d67cbdea1b161a61babdfaff6340b2dd4ec))
* **speckit:** resolve wrapper chains to the real command slot in taskstoissues-gate ([b9ed0cc](https://github.com/srobroek/omp-plugins/commit/b9ed0cce33c39366292d3772559486b6bbd81f8e))
* **speckit:** resolve wrapper chains to the real command slot in taskstoissues-gate ([01bbca9](https://github.com/srobroek/omp-plugins/commit/01bbca93b562eb07e5d626409f43adeb277005e9))

## [0.5.2](https://github.com/srobroek/omp-plugins/compare/speckit--v0.5.1...speckit--v0.5.2) (2026-08-25)


### Bug Fixes

* **speckit:** argv-parse taskstoissues instead of regex FP ([ee1b1ef](https://github.com/srobroek/omp-plugins/commit/ee1b1ef31fb717354177d9a60d95fba9f5bb94e7))
* **speckit:** argv-parse taskstoissues instead of regex FP ([a71bb32](https://github.com/srobroek/omp-plugins/commit/a71bb32c23c9b5e5dea06bad75136e6cc8c48512))

## [0.5.1](https://github.com/srobroek/omp-plugins/compare/speckit--v0.5.0...speckit--v0.5.1) (2026-08-25)


### Bug Fixes

* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([76caeec](https://github.com/srobroek/omp-plugins/commit/76caeec135b0b1943b6df551578cd6b6e7facd1b))
* **ttsr:** audit wave - retire and re-anchor the blocking rules ([a6ae591](https://github.com/srobroek/omp-plugins/commit/a6ae5911aa0ece0e8af982a43040ae8515970d3a))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/speckit--v0.4.0...speckit--v0.5.0) (2026-08-25)


### Features

* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/speckit--v0.3.0...speckit--v0.4.0) (2026-08-25)


### Features

* **beads:** own the gate-close guard, and make it watertight ([7663271](https://github.com/srobroek/omp-plugins/commit/7663271c1ff654e47897a96e72e60e2d8db75d47))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/speckit--v0.2.0...speckit--v0.3.0) (2026-08-25)


### Features

* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))
* **speckit:** three TTSR guards for workflow invariants ([d09c273](https://github.com/srobroek/omp-plugins/commit/d09c273253c317c49af194cf27d61c492093c415))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/speckit--v0.1.0...speckit--v0.2.0) (2026-08-25)


### Features

* work the migration backlog — speckit and project-setup plugins, TTSR adoptions, discovery tools ([90cae47](https://github.com/srobroek/omp-plugins/commit/90cae47f11df265138b099dcf1825daa14a22da0))
