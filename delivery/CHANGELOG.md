# Changelog

## [0.11.5](https://github.com/srobroek/omp-plugins/compare/delivery--v0.11.4...delivery--v0.11.5) (2026-09-21)


### Bug Fixes

* fail closed on unavailable repository probes ([#446](https://github.com/srobroek/omp-plugins/issues/446)) ([fc30b7b](https://github.com/srobroek/omp-plugins/commit/fc30b7b984a7ea4f27385321f139da64c57f9e0f))

## [0.11.4](https://github.com/srobroek/omp-plugins/compare/delivery--v0.11.3...delivery--v0.11.4) (2026-09-19)


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))

## [0.11.3](https://github.com/srobroek/omp-plugins/compare/delivery--v0.11.2...delivery--v0.11.3) (2026-09-19)


### Bug Fixes

* **beads:** ignore retired ledgers in PR gate ([c171c80](https://github.com/srobroek/omp-plugins/commit/c171c80295ca8feb19eff6bbd283a65d3347c2d5))
* **beads:** retire ledger activity without no-bead escape hatch ([dba55f8](https://github.com/srobroek/omp-plugins/commit/dba55f85d3f493c9a6357093f6abcc10fa4b5df5))

## [0.11.2](https://github.com/srobroek/omp-plugins/compare/delivery--v0.11.1...delivery--v0.11.2) (2026-09-16)


### Bug Fixes

* **delivery:** treat quoted argv data as non-executable ([ac6725d](https://github.com/srobroek/omp-plugins/commit/ac6725d8fc77bf4ef77071a05e0a251e1bd88ac9))

## [0.11.1](https://github.com/srobroek/omp-plugins/compare/delivery--v0.11.0...delivery--v0.11.1) (2026-09-16)


### Bug Fixes

* **delivery:** read only authorized index operations in a checkout ([3d97020](https://github.com/srobroek/omp-plugins/commit/3d9702027773339c7287cfd9796e12dd736cb1f2))


### Refactors

* **delivery:** replace blocking gates with push advisory ([#325](https://github.com/srobroek/omp-plugins/issues/325)) ([f65d1f5](https://github.com/srobroek/omp-plugins/commit/f65d1f5b38226a6627401a3b3ca95c26b08236a2))

## [0.11.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.11...delivery--v0.11.0) (2026-09-16)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))
* **delivery:** primary-checkout gate and worktree rules GW-5/GW-6 ([#192](https://github.com/srobroek/omp-plugins/issues/192)) ([e6d522c](https://github.com/srobroek/omp-plugins/commit/e6d522cadd06079e55b5d80260f2d3b3a9245ec9))
* **delivery:** require bounded automated review remediation ([49edfd2](https://github.com/srobroek/omp-plugins/commit/49edfd2075ac402e37df933f9143d05eaeb5e4d1))
* **delivery:** require conventional pull request titles ([#226](https://github.com/srobroek/omp-plugins/issues/226)) ([4dd9ff7](https://github.com/srobroek/omp-plugins/commit/4dd9ff79fcf26b985ff2e6c2b2efc261882b5951))
* **rules:** mechanize nine steering clauses as TTSR rules ([539efc0](https://github.com/srobroek/omp-plugins/commit/539efc02a153a2fddeab8d4bd2fee6ada30e7040))
* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))
* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))


### Bug Fixes

* **agents:** route operator to smol and PR reviewer to task ([#62](https://github.com/srobroek/omp-plugins/issues/62)) ([e2e2972](https://github.com/srobroek/omp-plugins/commit/e2e29728771251a8e838f2f1b9b560a832b61307))
* **authoring:** enforce agent metadata parity ([19ad6ae](https://github.com/srobroek/omp-plugins/commit/19ad6aeeb78038f74c0901bc5630c5f818c021d5))
* **changelog:** drop the entries my merge strategy duplicated ([525b7b1](https://github.com/srobroek/omp-plugins/commit/525b7b11dbe4c6dd85ff6073d916f6b3090bf5ff))
* **changelog:** drop the entries my merge strategy duplicated ([63f3643](https://github.com/srobroek/omp-plugins/commit/63f36438b0f0c9c86678c175c07cf5a3de452c91))
* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **delivery:** allow harness runtime worktree roots ([7d066ff](https://github.com/srobroek/omp-plugins/commit/7d066ff89c8ff12477eb77deb3a36b2e9984223a))
* **delivery:** allow runtime isolation roots ([#248](https://github.com/srobroek/omp-plugins/issues/248)) ([d18e900](https://github.com/srobroek/omp-plugins/commit/d18e900e3241d6470f7ac5458d24ef63a63f0174))
* **delivery:** allow slower remote anchor probes ([#317](https://github.com/srobroek/omp-plugins/issues/317)) ([8b408fb](https://github.com/srobroek/omp-plugins/commit/8b408fbc94cd034f374b21aa847f8d20365f257d))
* **delivery:** attribute unpushed commits to the session that made them ([a215a38](https://github.com/srobroek/omp-plugins/commit/a215a38e9139a0c77012f1608ff4c71457c7f67b))
* **delivery:** attribute unpushed commits to the session; summarise per-file diffs ([0ae7a0f](https://github.com/srobroek/omp-plugins/commit/0ae7a0f874e262d0f54cb75ada173e1a11a5be35))
* **delivery:** attribute untracked files the agent created ([5c3b985](https://github.com/srobroek/omp-plugins/commit/5c3b985fa0237ac831b530748c0e5df79e823313))
* **delivery:** attribute untracked files the agent created ([daf6654](https://github.com/srobroek/omp-plugins/commit/daf66543cb4b6556b3de7bbf5c457989940efe4e))
* **delivery:** harden canonical and primary checkout gates ([#294](https://github.com/srobroek/omp-plugins/issues/294)) ([49a7fe6](https://github.com/srobroek/omp-plugins/commit/49a7fe69c9f22bdc451359566778b9600e9259db))
* **delivery:** honor primary checkout grants ([#269](https://github.com/srobroek/omp-plugins/issues/269)) ([bc2e1cb](https://github.com/srobroek/omp-plugins/commit/bc2e1cb0c09a9ca7d1c45784e0495e472fd20771))
* **delivery:** make unpinned reads advisory ([#322](https://github.com/srobroek/omp-plugins/issues/322)) ([7832d9d](https://github.com/srobroek/omp-plugins/commit/7832d9dedde1c3179bf24cd9efe85296c4b88b6e))
* **delivery:** only command-slot git tokens count as invocations ([#52](https://github.com/srobroek/omp-plugins/issues/52)) ([cae7e6f](https://github.com/srobroek/omp-plugins/commit/cae7e6f4dad420f0ea13d91e8ac709dd5cc15cfa))
* **delivery:** read the branch of the repository the commit actually targets ([13899c6](https://github.com/srobroek/omp-plugins/commit/13899c6d464020278c71c340e9f57795d8dcdaaa))
* **delivery:** require resolved git verb in primary checkout gate ([#241](https://github.com/srobroek/omp-plugins/issues/241)) ([58977f3](https://github.com/srobroek/omp-plugins/commit/58977f39d5b4669913d45ae9c3b16b7ee5844766))
* **delivery:** require structured commit authority ([#147](https://github.com/srobroek/omp-plugins/issues/147)) ([9422cca](https://github.com/srobroek/omp-plugins/commit/9422ccac325e9894e9a401302ccb0d3f0da158cf))
* **delivery:** resolve child test module path ([0be13b9](https://github.com/srobroek/omp-plugins/commit/0be13b948548186e45ffbc8ccbc1cf96e82b134b))
* **delivery:** resolve child test module path ([0fa4686](https://github.com/srobroek/omp-plugins/commit/0fa46864032817cc8a7c94bb0e3f8127eeaba0aa))
* **delivery:** restore cd tracking, reconciled with the command-slot rule ([#54](https://github.com/srobroek/omp-plugins/issues/54)) ([a9f9b7e](https://github.com/srobroek/omp-plugins/commit/a9f9b7ef281994abf012979b856ff3de37dcbad2))
* **delivery:** satisfy the repository TypeScript and lint contract ([50b7657](https://github.com/srobroek/omp-plugins/commit/50b7657e0ff21578eba7e8a0d7a99bd2847ba13d))
* **delivery:** scope Bead linkage to agent-created PRs ([56dee62](https://github.com/srobroek/omp-plugins/commit/56dee62c8e02e71f3f6a891cc41b71f64e3466b6))
* **delivery:** scope commit authority and preserve hunk ownership ([d61bb1f](https://github.com/srobroek/omp-plugins/commit/d61bb1f52e0f0aee8140eb68114cfe3cc21af610))
* **delivery:** treat a branch-dependent cd as unknowable ([01a0942](https://github.com/srobroek/omp-plugins/commit/01a094263de845faae77094ba119e84198551235))
* **delivery:** trust remote steering sources ([ce43658](https://github.com/srobroek/omp-plugins/commit/ce43658be90aa22656fd973b2daf05c8e0400a4e))
* **delivery:** type the Git spawn adapter ([#321](https://github.com/srobroek/omp-plugins/issues/321)) ([facc4af](https://github.com/srobroek/omp-plugins/commit/facc4af1537c886fb7caaf4526bc5392cf64a3e6))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))
* repair the journeys symlink guard and the session-commit test's git isolation ([#172](https://github.com/srobroek/omp-plugins/issues/172)) ([c9ccd43](https://github.com/srobroek/omp-plugins/commit/c9ccd4353ebabfcc87ebb93aab67f429fcfb8b64))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([76caeec](https://github.com/srobroek/omp-plugins/commit/76caeec135b0b1943b6df551578cd6b6e7facd1b))
* **ttsr:** audit wave - retire and re-anchor the blocking rules ([a6ae591](https://github.com/srobroek/omp-plugins/commit/a6ae5911aa0ece0e8af982a43040ae8515970d3a))


### Refactors

* retire redundant agents and repair role routing ([#66](https://github.com/srobroek/omp-plugins/issues/66)) ([1a8dbb2](https://github.com/srobroek/omp-plugins/commit/1a8dbb24f127dfcbacb624857459a36a918ca4e6))
* **safety:** apply the safety, toolchain, delivery and ops rules audit ([#254](https://github.com/srobroek/omp-plugins/issues/254)) ([f86c53c](https://github.com/srobroek/omp-plugins/commit/f86c53c98d194aa4b8bfe98c387951eb9042e37a))


### Documentation

* clarify plugin safety and usage contracts ([f147fba](https://github.com/srobroek/omp-plugins/commit/f147fbaa08ddae1f5d745defd613b2d33ece4d61))
* **delivery:** GW-6 names the installed post-start prune hook ([#201](https://github.com/srobroek/omp-plugins/issues/201)) ([bbb685f](https://github.com/srobroek/omp-plugins/commit/bbb685fbe7c55e0c1e866b59e6dfbc8f2c59391b))
* **delivery:** primary-checkout gate is advisory-strength; shell writes are not parsed ([#199](https://github.com/srobroek/omp-plugins/issues/199)) ([e467692](https://github.com/srobroek/omp-plugins/commit/e467692ae26825d94d99c0bbca409ef314854c43))
* **steering:** own commit/push policy in git rules; ban narrating foreign state ([ccef816](https://github.com/srobroek/omp-plugins/commit/ccef816ac76cf318d5c4871919953ba6b2989eef))

## [0.10.11](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.10...delivery--v0.10.11) (2026-09-16)


### Bug Fixes

* **delivery:** allow untrusted-origin Git reads while keeping pushes fail-closed

## [0.10.10](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.9...delivery--v0.10.10) (2026-09-16)


### Bug Fixes

* **delivery:** allow slower remote anchor probes ([#317](https://github.com/srobroek/omp-plugins/issues/317)) ([8b408fb](https://github.com/srobroek/omp-plugins/commit/8b408fbc94cd034f374b21aa847f8d20365f257d))
* **delivery:** type the Git spawn adapter ([#321](https://github.com/srobroek/omp-plugins/issues/321)) ([facc4af](https://github.com/srobroek/omp-plugins/commit/facc4af1537c886fb7caaf4526bc5392cf64a3e6))

## [0.10.9](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.8...delivery--v0.10.9) (2026-09-16)


### Bug Fixes

* **delivery:** scope Bead linkage to agent-created PRs ([56dee62](https://github.com/srobroek/omp-plugins/commit/56dee62c8e02e71f3f6a891cc41b71f64e3466b6))

## [0.10.8](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.7...delivery--v0.10.8) (2026-09-15)


### Bug Fixes

* **delivery:** harden canonical and primary checkout gates ([#294](https://github.com/srobroek/omp-plugins/issues/294)) ([49a7fe6](https://github.com/srobroek/omp-plugins/commit/49a7fe69c9f22bdc451359566778b9600e9259db))

## [0.10.7](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.6...delivery--v0.10.7) (2026-09-15)


### Bug Fixes

* **delivery:** trust remote steering sources ([ce43658](https://github.com/srobroek/omp-plugins/commit/ce43658be90aa22656fd973b2daf05c8e0400a4e))

## [0.10.6](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.5...delivery--v0.10.6) (2026-09-14)


### Bug Fixes

* **delivery:** resolve child test module path ([0be13b9](https://github.com/srobroek/omp-plugins/commit/0be13b948548186e45ffbc8ccbc1cf96e82b134b))
* **delivery:** resolve child test module path ([0fa4686](https://github.com/srobroek/omp-plugins/commit/0fa46864032817cc8a7c94bb0e3f8127eeaba0aa))

## [0.10.5](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.4...delivery--v0.10.5) (2026-09-14)


### Bug Fixes

* **delivery:** honor primary checkout grants ([#269](https://github.com/srobroek/omp-plugins/issues/269)) ([bc2e1cb](https://github.com/srobroek/omp-plugins/commit/bc2e1cb0c09a9ca7d1c45784e0495e472fd20771))

## [0.10.4](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.3...delivery--v0.10.4) (2026-09-14)


### Bug Fixes

* **delivery:** allow harness runtime worktree roots ([7d066ff](https://github.com/srobroek/omp-plugins/commit/7d066ff89c8ff12477eb77deb3a36b2e9984223a))

## [0.10.3](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.2...delivery--v0.10.3) (2026-09-13)


### Refactors

* **safety:** apply the safety, toolchain, delivery and ops rules audit ([#254](https://github.com/srobroek/omp-plugins/issues/254)) ([f86c53c](https://github.com/srobroek/omp-plugins/commit/f86c53c98d194aa4b8bfe98c387951eb9042e37a))

## [0.10.2](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.1...delivery--v0.10.2) (2026-09-13)


### Bug Fixes

* **delivery:** allow runtime isolation roots ([#248](https://github.com/srobroek/omp-plugins/issues/248)) ([d18e900](https://github.com/srobroek/omp-plugins/commit/d18e900e3241d6470f7ac5458d24ef63a63f0174))

## [0.10.1](https://github.com/srobroek/omp-plugins/compare/delivery--v0.10.0...delivery--v0.10.1) (2026-09-13)


### Bug Fixes

* **delivery:** require resolved git verb in primary checkout gate ([#241](https://github.com/srobroek/omp-plugins/issues/241)) ([58977f3](https://github.com/srobroek/omp-plugins/commit/58977f39d5b4669913d45ae9c3b16b7ee5844766))

## [0.10.0](https://github.com/srobroek/omp-plugins/compare/delivery--v0.9.1...delivery--v0.10.0) (2026-09-12)


### Features

* **delivery:** require conventional pull request titles ([#226](https://github.com/srobroek/omp-plugins/issues/226)) ([4dd9ff7](https://github.com/srobroek/omp-plugins/commit/4dd9ff79fcf26b985ff2e6c2b2efc261882b5951))

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
