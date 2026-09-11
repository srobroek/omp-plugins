# Changelog

## [2.0.1](https://github.com/srobroek/omp-plugins/compare/authoring--v2.0.0...authoring--v2.0.1) (2026-09-11)


### Bug Fixes

* **authoring:** preserve agentic lint source lines ([45409ec](https://github.com/srobroek/omp-plugins/commit/45409ecd4373f2b694d6b850effc2beee076f8a0))
* **authoring:** satisfy the repository TypeScript and lint contract ([a2cfe37](https://github.com/srobroek/omp-plugins/commit/a2cfe3707a0a8d1b416084e32af25f5a93ed5835))
* **authoring:** unify applied ast edit paths ([eba945c](https://github.com/srobroek/omp-plugins/commit/eba945caabdbb07bf6f46aa4fc7c5b0712c092d3))
* **authoring:** validate agent metadata types ([d52a5f2](https://github.com/srobroek/omp-plugins/commit/d52a5f287cad6fa75574c4ce2abb97d5edf1b593))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [2.0.0](https://github.com/srobroek/omp-plugins/compare/authoring--v1.3.0...authoring--v2.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* Drop support for APM formats and sidecar agent contracts.

### Features

* retire APM formats and add staged lint ([#68](https://github.com/srobroek/omp-plugins/issues/68)) ([07996f1](https://github.com/srobroek/omp-plugins/commit/07996f115baddbe4261ce6892100238bff2310bd))


### Refactors

* retire redundant agents and repair role routing ([#66](https://github.com/srobroek/omp-plugins/issues/66)) ([1a8dbb2](https://github.com/srobroek/omp-plugins/commit/1a8dbb24f127dfcbacb624857459a36a918ca4e6))

## [1.3.0](https://github.com/srobroek/omp-plugins/compare/authoring--v1.2.1...authoring--v1.3.0) (2026-09-08)


### Features

* **project:** add agentic scaffolding and repository context hooks ([#64](https://github.com/srobroek/omp-plugins/issues/64)) ([974536d](https://github.com/srobroek/omp-plugins/commit/974536df3e3c75d6d4f9128b6477c2eb9412cf86))

## [1.2.1](https://github.com/srobroek/omp-plugins/compare/authoring--v1.2.0...authoring--v1.2.1) (2026-09-08)


### Bug Fixes

* **authoring:** validate native assets without synthetic parity fixtures ([38a177d](https://github.com/srobroek/omp-plugins/commit/38a177d08d8421cb228dbf1ce5976513eef35fe6))
* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))

## [1.2.0](https://github.com/srobroek/omp-plugins/compare/authoring--v1.1.2...authoring--v1.2.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))

## [1.1.2](https://github.com/srobroek/omp-plugins/compare/authoring--v1.1.1...authoring--v1.1.2) (2026-08-25)


### Bug Fixes

* **changelog:** drop the entries my merge strategy duplicated ([525b7b1](https://github.com/srobroek/omp-plugins/commit/525b7b11dbe4c6dd85ff6073d916f6b3090bf5ff))

## [1.1.1](https://github.com/srobroek/omp-plugins/compare/authoring--v1.1.0...authoring--v1.1.1) (2026-08-25)


### Bug Fixes

* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([76caeec](https://github.com/srobroek/omp-plugins/commit/76caeec135b0b1943b6df551578cd6b6e7facd1b))
* **ttsr:** audit wave - loosen the advisory rules and move canonicalize to clippy ([72d5cd1](https://github.com/srobroek/omp-plugins/commit/72d5cd15d167c21a8a153012af2acec7c0362309))

## [1.1.0](https://github.com/srobroek/omp-plugins/compare/authoring--v1.0.0...authoring--v1.1.0) (2026-08-25)


### Features

* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/authoring--v0.3.0...authoring--v1.0.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* the session plugin no longer exists; unlink it locally.

### Features

* remove the session plugin ([bc4049d](https://github.com/srobroek/omp-plugins/commit/bc4049d520d5bd72c1e1551ec49aa9a516c33c8c))
* **rules:** mechanize nine steering clauses as TTSR rules ([539efc0](https://github.com/srobroek/omp-plugins/commit/539efc02a153a2fddeab8d4bd2fee6ada30e7040))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/authoring--v0.2.0...authoring--v0.3.0) (2026-08-25)


### Features

* **authoring,chezmoi:** lint reminder, repomix TTSR, secret commit gate ([90b8c58](https://github.com/srobroek/omp-plugins/commit/90b8c5817c69c845282a04e042be60c2b2992136))
* **authoring:** lint machine-specific paths and unrepairable frontmatter ([a456af3](https://github.com/srobroek/omp-plugins/commit/a456af3e109c44d1ad1dfbed2078b0a0b8202ccd))
* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/authoring--v0.1.0...authoring--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
* work the migration backlog — speckit and project-setup plugins, TTSR adoptions, discovery tools ([90cae47](https://github.com/srobroek/omp-plugins/commit/90cae47f11df265138b099dcf1825daa14a22da0))
