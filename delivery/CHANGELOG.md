# Changelog

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
