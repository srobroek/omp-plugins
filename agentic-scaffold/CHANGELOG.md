# Changelog

## [0.5.10](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.9...agentic-scaffold--v0.5.10) (2026-09-10)


### Documentation

* **agentic-scaffold:** scope the confirmation gates; handle inspect failure; align verify.md ([#150](https://github.com/srobroek/omp-plugins/issues/150)) ([bda29c2](https://github.com/srobroek/omp-plugins/commit/bda29c22cb388d34eacad96ff4c1749e20b840b8))

## [0.5.9](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.8...agentic-scaffold--v0.5.9) (2026-09-10)


### Documentation

* **agentic-scaffold:** every stop is an ask; inspect and preflight end in a confirmation ([#146](https://github.com/srobroek/omp-plugins/issues/146)) ([fb486f9](https://github.com/srobroek/omp-plugins/commit/fb486f96fe88d0ccd80eb5470f5ee99213407862))

## [0.5.8](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.7...agentic-scaffold--v0.5.8) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** stop choosing a beads database ([#133](https://github.com/srobroek/omp-plugins/issues/133)) ([6a9d1da](https://github.com/srobroek/omp-plugins/commit/6a9d1dad9d1adcfaab832bdc149faea49ca4a477))

## [0.5.7](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.6...agentic-scaffold--v0.5.7) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** keep an inherited absolute BEADS_DIR pin for the scaffold's bd calls ([#131](https://github.com/srobroek/omp-plugins/issues/131)) ([de0b9b8](https://github.com/srobroek/omp-plugins/commit/de0b9b8afe09b6b5eabb92ae1b52cb9bda6007c1))

## [0.5.6](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.5...agentic-scaffold--v0.5.6) (2026-09-10)


### Bug Fixes

* **beads,agentic-scaffold:** pin BEADS_DIR automatically and survive a mid-session plugin upgrade ([#129](https://github.com/srobroek/omp-plugins/issues/129)) ([0dc7658](https://github.com/srobroek/omp-plugins/commit/0dc76589969ec18c0efd6bd17ce34eabb31ff894))

## [0.5.5](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.4...agentic-scaffold--v0.5.5) (2026-09-10)


### Documentation

* **agentic-scaffold:** write the plan as an artifact before asking, like plan mode ([#127](https://github.com/srobroek/omp-plugins/issues/127)) ([2946468](https://github.com/srobroek/omp-plugins/commit/29464683d0fc13f3bb00ca90f662a9d956901800))

## [0.5.4](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.3...agentic-scaffold--v0.5.4) (2026-09-10)


### Documentation

* **agentic-scaffold:** use the plan-mode proposal flow when plan mode is active ([#124](https://github.com/srobroek/omp-plugins/issues/124)) ([c56da18](https://github.com/srobroek/omp-plugins/commit/c56da18cce8e9cf7fc287ef41bac963d42be7e9c))

## [0.5.3](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.2...agentic-scaffold--v0.5.3) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** layer multi-select, compact plan summary, per-path abort revert ([#121](https://github.com/srobroek/omp-plugins/issues/121)) ([b8d193d](https://github.com/srobroek/omp-plugins/commit/b8d193d28d5a4092fbe1e4e1a4694ea9fe45c75a))


### Documentation

* **agentic-scaffold:** hook strategy is detected, not chosen in the interview ([#123](https://github.com/srobroek/omp-plugins/issues/123)) ([051c59f](https://github.com/srobroek/omp-plugins/commit/051c59f2af933c185973821f7d4d7e4382b8ebac))

## [0.5.2](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.1...agentic-scaffold--v0.5.2) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** write guarded files atomically ([#119](https://github.com/srobroek/omp-plugins/issues/119)) ([d0be49b](https://github.com/srobroek/omp-plugins/commit/d0be49bc3bf17f585f99a6dfdce7c27d71bad840))

## [0.5.1](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.5.0...agentic-scaffold--v0.5.1) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** abort reports hadRun from the marker's existence ([#117](https://github.com/srobroek/omp-plugins/issues/117)) ([9b9356d](https://github.com/srobroek/omp-plugins/commit/9b9356de32f3df9e68e1b354d4397e8c7c2c9921))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.4.3...agentic-scaffold--v0.5.0) (2026-09-10)


### Features

* **agentic-scaffold:** abort command closes a crashed run ([#115](https://github.com/srobroek/omp-plugins/issues/115)) ([6bf2891](https://github.com/srobroek/omp-plugins/commit/6bf2891e45bda3a8c3ea0af1f09ef2a9b074951d))

## [0.4.3](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.4.2...agentic-scaffold--v0.4.3) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** name the finish state so a pending commit is not reported as failure ([#113](https://github.com/srobroek/omp-plugins/issues/113)) ([94b837c](https://github.com/srobroek/omp-plugins/commit/94b837c6032b402c849dd746e07c64febb0823e8))

## [0.4.2](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.4.1...agentic-scaffold--v0.4.2) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** valid TOML for finding answers, no hook question when git-defender decides, inspect in the tool ([#111](https://github.com/srobroek/omp-plugins/issues/111)) ([df05568](https://github.com/srobroek/omp-plugins/commit/df05568e75dccb376218591f551ce97a9c731629))

## [0.4.1](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.4.0...agentic-scaffold--v0.4.1) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** pin beads only when the interview answered beads=true ([#109](https://github.com/srobroek/omp-plugins/issues/109)) ([a34b835](https://github.com/srobroek/omp-plugins/commit/a34b8352f605aeaabe7788532a34abef810b351a))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.3.2...agentic-scaffold--v0.4.0) (2026-09-10)


### Features

* **agentic-scaffold:** deterministic apply pipeline, hard boundary, mandatory interview ([#107](https://github.com/srobroek/omp-plugins/issues/107)) ([c6de4c5](https://github.com/srobroek/omp-plugins/commit/c6de4c58dedc14676061d0a49bdd9933ac3e084d))

## [0.3.2](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.3.1...agentic-scaffold--v0.3.2) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** count a project plugin as installed only while its install path exists ([#106](https://github.com/srobroek/omp-plugins/issues/106)) ([3d9797c](https://github.com/srobroek/omp-plugins/commit/3d9797c82baef68223e0c7ad023addfc325c1bf6))

## [0.3.1](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.3.0...agentic-scaffold--v0.3.1) (2026-09-10)


### Bug Fixes

* **agentic-scaffold:** monorepo just aggregates depend on member recipes ([6daad53](https://github.com/srobroek/omp-plugins/commit/6daad53bb0386f3823488baa9632ad0b2069f396))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.2.0...agentic-scaffold--v0.3.0) (2026-09-10)


### Features

* **agentic-scaffold:** monorepo workspaces with nested member layers ([c36a617](https://github.com/srobroek/omp-plugins/commit/c36a617a5fc876ea04fad4d020b083327e1111d6))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/agentic-scaffold--v0.1.0...agentic-scaffold--v0.2.0) (2026-09-09)


### Features

* **agentic-scaffold:** formula-driven scaffold plugin; move it out of project ([8f71d19](https://github.com/srobroek/omp-plugins/commit/8f71d19d4703214ae0352117305e48d3f95f2528))

## Changelog
