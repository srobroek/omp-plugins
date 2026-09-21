# Changelog

## [1.2.0](https://github.com/srobroek/omp-plugins/compare/worktrunk--v1.1.1...worktrunk--v1.2.0) (2026-09-21)


### Features

* **project-setup:** replace scaffold runtime ([#436](https://github.com/srobroek/omp-plugins/issues/436)) ([f8fd91b](https://github.com/srobroek/omp-plugins/commit/f8fd91b75ec57d667a209ba68c771a04c0501464))

## [1.1.1](https://github.com/srobroek/omp-plugins/compare/worktrunk--v1.1.0...worktrunk--v1.1.1) (2026-09-20)


### Bug Fixes

* **worktree-gate:** exempt orchestrate ledger calls ([#428](https://github.com/srobroek/omp-plugins/issues/428)) ([04ba42f](https://github.com/srobroek/omp-plugins/commit/04ba42f362e93ab39070d1662879df2f6091802b))

## [1.1.0](https://github.com/srobroek/omp-plugins/compare/worktrunk--v1.0.1...worktrunk--v1.1.0) (2026-09-19)


### Features

* **worktrunk:** allow canonical read-only probes ([#422](https://github.com/srobroek/omp-plugins/issues/422)) ([e7ae00e](https://github.com/srobroek/omp-plugins/commit/e7ae00e66ee5c9dc3ee92fe7a663f0ba299d82b0))


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))

## [1.0.1](https://github.com/srobroek/omp-plugins/compare/worktrunk--v1.0.0...worktrunk--v1.0.1) (2026-09-19)


### Bug Fixes

* **beads:** one shared shell tokenizer, and close two gate fail-opens ([#402](https://github.com/srobroek/omp-plugins/issues/402)) ([264facb](https://github.com/srobroek/omp-plugins/commit/264facb1ac2a07a53f3dd668fdf98d6b8443ec1c))


### Documentation

* **worktrunk:** correct 1.0.0 changelog ([#399](https://github.com/srobroek/omp-plugins/issues/399)) ([ad1a44e](https://github.com/srobroek/omp-plugins/commit/ad1a44e5fbf14c79fcf6a14f6e58bfd0fd447b6c))

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.8...worktrunk--v1.0.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* **worktrunk:** the gate judges only filesystem paths resolved from call arguments. Calls resolving to no path are allowed, including `xd://retain` and `typescript_quality {"mode": "fix"}` from a canonical checkout. A canonical path nested in a device payload is still refused. `bash` and `eval` are judged by explicit `cwd`; `write`, `edit`, and `ast_edit` are judged by their explicit targets. This behavior shipped in 0.2.8 ([c419031](https://github.com/srobroek/omp-plugins/commit/c41903147eb714386cd625f10e7a2d08ec5fb345)) and applies to upgrades from 0.2.7.

### Documentation

* **beads:** remove Dolt server policy surfaces ([#396](https://github.com/srobroek/omp-plugins/issues/396)) ([831467e](https://github.com/srobroek/omp-plugins/commit/831467eb815b4237991fd64d2df5bd7b6e0eebc3))

## [0.2.8](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.7...worktrunk--v0.2.8) (2026-09-19)


### Bug Fixes

* **worktrunk:** judge only resolvable filesystem paths ([c419031](https://github.com/srobroek/omp-plugins/commit/c41903147eb714386cd625f10e7a2d08ec5fb345))

## [0.2.7](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.6...worktrunk--v0.2.7) (2026-09-18)


### Bug Fixes

* **worktrunk:** own the target's repository and close three gate bypasses ([#357](https://github.com/srobroek/omp-plugins/issues/357)) ([05d3c33](https://github.com/srobroek/omp-plugins/commit/05d3c33a06554db8a0d33a0017a5e344137eab3d))


### Documentation

* **worktrunk:** require authoring the provisioning files, not only checking ([#385](https://github.com/srobroek/omp-plugins/issues/385)) ([083ffaf](https://github.com/srobroek/omp-plugins/commit/083ffaf2d1b6a407300babf2917301cdc85671dd))
* **worktrunk:** require dependency provisioning ([#384](https://github.com/srobroek/omp-plugins/issues/384)) ([04b4146](https://github.com/srobroek/omp-plugins/commit/04b4146db7caaf164e87f20d7724869c306a460c))
* **worktrunk:** require provenance before a destructive ref deletion ([#382](https://github.com/srobroek/omp-plugins/issues/382)) ([3a417f4](https://github.com/srobroek/omp-plugins/commit/3a417f4ece1847407352e673c4b2a8b1459183f7))

## [0.2.6](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.5...worktrunk--v0.2.6) (2026-09-18)


### Bug Fixes

* **worktrunk:** resolve the gate's repository from a directory, not a file ([#380](https://github.com/srobroek/omp-plugins/issues/380)) ([da9384b](https://github.com/srobroek/omp-plugins/commit/da9384b996c82306f22490007ca076d5e35959a8))

## [0.2.5](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.4...worktrunk--v0.2.5) (2026-09-18)


### Bug Fixes

* **worktrunk:** resolve command segments in the canonical bootstrap allowlist ([#375](https://github.com/srobroek/omp-plugins/issues/375)) ([298a967](https://github.com/srobroek/omp-plugins/commit/298a9679bd0fb0bd4aac7bc32963ba7286f83998))

## [0.2.4](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.3...worktrunk--v0.2.4) (2026-09-18)


### Bug Fixes

* **worktrunk:** allow resume session inspection ([#372](https://github.com/srobroek/omp-plugins/issues/372)) ([52c5b41](https://github.com/srobroek/omp-plugins/commit/52c5b4126c6ed2e30e3d0773a05af4e54352b107))

## [0.2.3](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.2...worktrunk--v0.2.3) (2026-09-18)


### Bug Fixes

* **worktrunk:** honor authorized primary checkouts ([#370](https://github.com/srobroek/omp-plugins/issues/370)) ([badedee](https://github.com/srobroek/omp-plugins/commit/badedee729c66d4c13db4bed17d66a22a789e0f6))

## [0.2.2](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.1...worktrunk--v0.2.2) (2026-09-18)


### Bug Fixes

* **worktrunk:** judge invocations and scope the gate to its own project ([#360](https://github.com/srobroek/omp-plugins/issues/360)) ([1a04cd2](https://github.com/srobroek/omp-plugins/commit/1a04cd2b336072b8b8e64ba2f6556fcc32b545d8))

## [0.2.1](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.2.0...worktrunk--v0.2.1) (2026-09-18)


### Bug Fixes

* **worktrunk:** refuse unreadable repository metadata ([#354](https://github.com/srobroek/omp-plugins/issues/354)) ([03203b6](https://github.com/srobroek/omp-plugins/commit/03203b6b0dd1091772f2d39eb2326401bf34d6e8))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/worktrunk--v0.1.0...worktrunk--v0.2.0) (2026-09-18)


### Features

* **worktrunk:** enforce linked-worktree agent writes ([#350](https://github.com/srobroek/omp-plugins/issues/350)) ([de641bf](https://github.com/srobroek/omp-plugins/commit/de641bf60fa87c991bda8ff2a30784eb778b1a80))
