# Changelog

## [0.9.1](https://github.com/srobroek/omp-plugins/compare/delivery--v0.9.0...delivery--v0.9.1) (2026-09-11)


### Documentation

* **delivery:** GW-6 names the installed post-start prune hook ([#201](https://github.com/srobroek/omp-plugins/issues/201)) ([bbb685f](https://github.com/srobroek/omp-plugins/commit/bbb685fbe7c55e0c1e866b59e6dfbc8f2c59391b))
* **delivery:** primary-checkout gate is advisory-strength; shell writes are not parsed ([#199](https://github.com/srobroek/omp-plugins/issues/199)) ([e467692](https://github.com/srobroek/omp-plugins/commit/e467692ae26825d94d99c0bbca409ef314854c43))

## [0.9.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.8.3...delivery--v0.9.0) (2026-09-11)


### Features

* **delivery:** primary-checkout gate and worktree rules GW-5/GW-6 ([#192](https://github.com/srobroek/omp-plugins/issues/192)) ([e6d522c](https://github.com/srobroek/omp-plugins/commit/e6d522cadd06079e55b5d80260f2d3b3a9245ec9))

## [0.8.3](https://github.com/srobroek/omp-plugins/compare/delivery--v0.8.2...delivery--v0.8.3) (2026-09-11)


### Bug Fixes

* repair the journeys symlink guard and the session-commit test's git isolation ([#172](https://github.com/srobroek/omp-plugins/issues/172)) ([c9ccd43](https://github.com/srobroek/omp-plugins/commit/c9ccd4353ebabfcc87ebb93aab67f429fcfb8b64))

## [0.8.2](https://github.com/srobroek/omp-plugins/compare/delivery--v0.8.1...delivery--v0.8.2) (2026-09-11)


### Bug Fixes

* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [0.8.1](https://github.com/srobroek/omp-plugins/compare/delivery--v0.8.0...delivery--v0.8.1) (2026-09-10)


### Bug Fixes

* **delivery:** require structured commit authority ([#147](https://github.com/srobroek/omp-plugins/issues/147)) ([9422cca](https://github.com/srobroek/omp-plugins/commit/9422ccac325e9894e9a401302ccb0d3f0da158cf))

## [0.8.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.7.3...delivery--v0.8.0) (2026-09-09)


### Features

* **delivery:** require bounded automated review remediation ([49edfd2](https://github.com/srobroek/omp-plugins/commit/49edfd2075ac402e37df933f9143d05eaeb5e4d1))

## [0.7.3](https://github.com/srobroek/omp-plugins/compare/delivery--v0.7.2...delivery--v0.7.3) (2026-09-08)


### Refactors

* retire redundant agents and repair role routing ([#66](https://github.com/srobroek/omp-plugins/issues/66)) ([1a8dbb2](https://github.com/srobroek/omp-plugins/commit/1a8dbb24f127dfcbacb624857459a36a918ca4e6))

## [0.7.2](https://github.com/srobroek/omp-plugins/compare/delivery--v0.7.1...delivery--v0.7.2) (2026-09-08)


### Bug Fixes

* **agents:** route operator to smol and PR reviewer to task ([#62](https://github.com/srobroek/omp-plugins/issues/62)) ([e2e2972](https://github.com/srobroek/omp-plugins/commit/e2e29728771251a8e838f2f1b9b560a832b61307))

## [0.7.1](https://github.com/srobroek/omp-plugins/compare/delivery--v0.7.0...delivery--v0.7.1) (2026-09-08)


### Bug Fixes

* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **delivery:** scope commit authority and preserve hunk ownership ([d61bb1f](https://github.com/srobroek/omp-plugins/commit/d61bb1f52e0f0aee8140eb68114cfe3cc21af610))


### Documentation

* clarify plugin safety and usage contracts ([f147fba](https://github.com/srobroek/omp-plugins/commit/f147fbaa08ddae1f5d745defd613b2d33ece4d61))

## [0.7.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.6.2...delivery--v0.7.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))


### Bug Fixes

* **delivery:** only command-slot git tokens count as invocations ([#52](https://github.com/srobroek/omp-plugins/issues/52)) ([cae7e6f](https://github.com/srobroek/omp-plugins/commit/cae7e6f4dad420f0ea13d91e8ac709dd5cc15cfa))
* **delivery:** read the branch of the repository the commit actually targets ([13899c6](https://github.com/srobroek/omp-plugins/commit/13899c6d464020278c71c340e9f57795d8dcdaaa))
* **delivery:** restore cd tracking, reconciled with the command-slot rule ([#54](https://github.com/srobroek/omp-plugins/issues/54)) ([a9f9b7e](https://github.com/srobroek/omp-plugins/commit/a9f9b7ef281994abf012979b856ff3de37dcbad2))
* **delivery:** treat a branch-dependent cd as unknowable ([01a0942](https://github.com/srobroek/omp-plugins/commit/01a094263de845faae77094ba119e84198551235))

## [0.6.2](https://github.com/srobroek/omp-plugins/compare/delivery--v0.6.1...delivery--v0.6.2) (2026-08-25)


### Bug Fixes

* **changelog:** drop the entries my merge strategy duplicated ([525b7b1](https://github.com/srobroek/omp-plugins/commit/525b7b11dbe4c6dd85ff6073d916f6b3090bf5ff))

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/delivery--v0.6.0...delivery--v0.6.1) (2026-08-25)


### Bug Fixes

* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([76caeec](https://github.com/srobroek/omp-plugins/commit/76caeec135b0b1943b6df551578cd6b6e7facd1b))
* **ttsr:** audit wave - retire and re-anchor the blocking rules ([a6ae591](https://github.com/srobroek/omp-plugins/commit/a6ae5911aa0ece0e8af982a43040ae8515970d3a))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.5.0...delivery--v0.6.0) (2026-08-25)


### Features

* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.4.0...delivery--v0.5.0) (2026-08-25)


### Features

* **rules:** mechanize nine steering clauses as TTSR rules ([539efc0](https://github.com/srobroek/omp-plugins/commit/539efc02a153a2fddeab8d4bd2fee6ada30e7040))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.3.0...delivery--v0.4.0) (2026-08-25)


### Features

* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))


### Bug Fixes

* **delivery:** attribute unpushed commits to the session that made them ([a215a38](https://github.com/srobroek/omp-plugins/commit/a215a38e9139a0c77012f1608ff4c71457c7f67b))
* **delivery:** attribute unpushed commits to the session; summarise per-file diffs ([0ae7a0f](https://github.com/srobroek/omp-plugins/commit/0ae7a0f874e262d0f54cb75ada173e1a11a5be35))
* **delivery:** attribute untracked files the agent created ([daf6654](https://github.com/srobroek/omp-plugins/commit/daf66543cb4b6556b3de7bbf5c457989940efe4e))


### Documentation

* **steering:** own commit/push policy in git rules; ban narrating foreign state ([ccef816](https://github.com/srobroek/omp-plugins/commit/ccef816ac76cf318d5c4871919953ba6b2989eef))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.2.0...delivery--v0.3.0) (2026-08-25)


### Features

* **beads,delivery:** claim-without-actor gate and unpushed-work stop advisory ([6d68bf2](https://github.com/srobroek/omp-plugins/commit/6d68bf2d9a5d570a9facbad2b2a31823f14fa43e))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.1.0...delivery--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
* work the migration backlog — speckit and project-setup plugins, TTSR adoptions, discovery tools ([90cae47](https://github.com/srobroek/omp-plugins/commit/90cae47f11df265138b099dcf1825daa14a22da0))
