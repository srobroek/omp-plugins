# Changelog

## [0.8.0](https://github.com/srobroek/omp-plugins/compare/safety--v0.7.0...safety--v0.8.0) (2026-09-22)


### Features

* **safety:** refuse worktree removals that orphan a commit ([#456](https://github.com/srobroek/omp-plugins/issues/456)) ([fe5c0bd](https://github.com/srobroek/omp-plugins/commit/fe5c0bd81271ce846f0522f18f768547230ab84b))

## [0.7.0](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.8...safety--v0.7.0) (2026-09-21)


### Features


## [0.6.8](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.7...safety--v0.6.8) (2026-09-20)


### Bug Fixes

* **safety:** guard worktree, branch and stash destruction ([#434](https://github.com/srobroek/omp-plugins/issues/434)) ([2de0096](https://github.com/srobroek/omp-plugins/commit/2de0096484e595a437cef3f27d9b33d807dc58ff))
* **safety:** stop the destruction guard blocking automatic worktree cleanup ([#435](https://github.com/srobroek/omp-plugins/issues/435)) ([ac4ad51](https://github.com/srobroek/omp-plugins/commit/ac4ad510fb2fca4056817d01d19dfde7e3e6d8be))

## [0.6.7](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.6...safety--v0.6.7) (2026-09-19)


### Bug Fixes

* **plugins:** harden security-sensitive extensions ([#416](https://github.com/srobroek/omp-plugins/issues/416)) ([b7837ef](https://github.com/srobroek/omp-plugins/commit/b7837ef55c334293a1381d66fb52d207226aa694))
* **safety:** investigate package operations inside subshells ([#424](https://github.com/srobroek/omp-plugins/issues/424)) ([d099477](https://github.com/srobroek/omp-plugins/commit/d099477c9a805b1e7791ac1534d42b3291cec049))


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))

## [0.6.6](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.5...safety--v0.6.6) (2026-09-19)


### Bug Fixes

* **safety:** decide package investigation from tokens, not text ([#403](https://github.com/srobroek/omp-plugins/issues/403)) ([095edb4](https://github.com/srobroek/omp-plugins/commit/095edb48ed4d8b2c1a883e8167d1b3d1ba4c6c1b))

## [0.6.5](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.4...safety--v0.6.5) (2026-09-19)


### Bug Fixes

* **safety:** narrow package investigation matcher ([#387](https://github.com/srobroek/omp-plugins/issues/387)) ([5641d2a](https://github.com/srobroek/omp-plugins/commit/5641d2a283b86fb59e9c095283468b8d2b3600df))

## [0.6.4](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.3...safety--v0.6.4) (2026-09-13)


### Refactors

* **safety:** apply the safety, toolchain, delivery and ops rules audit ([#254](https://github.com/srobroek/omp-plugins/issues/254)) ([f86c53c](https://github.com/srobroek/omp-plugins/commit/f86c53c98d194aa4b8bfe98c387951eb9042e37a))

## [0.6.3](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.2...safety--v0.6.3) (2026-09-13)


### Bug Fixes

* **safety:** anchor package investigation rule ([#238](https://github.com/srobroek/omp-plugins/issues/238)) ([82dc7bb](https://github.com/srobroek/omp-plugins/commit/82dc7bbdb88425c4b435e4457504a62f0fd4ef9d))

## [0.6.2](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.1...safety--v0.6.2) (2026-09-11)


### Bug Fixes

* **safety:** exempt safe force-push options ([#177](https://github.com/srobroek/omp-plugins/issues/177)) ([fba4c53](https://github.com/srobroek/omp-plugins/commit/fba4c536cc8be2a014599da51c16822a0c3a5107))

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/safety--v0.6.0...safety--v0.6.1) (2026-09-11)


### Bug Fixes

* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))
* **safety:** honour the per-call cwd when advising on edits ([c5d3d50](https://github.com/srobroek/omp-plugins/commit/c5d3d501bdfbfb2b5ade964bf5bff6e430dc5c90))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/safety--v0.5.3...safety--v0.6.0) (2026-09-10)


### Features

* **safety:** resume a turn that ends on a provider quota notice ([#101](https://github.com/srobroek/omp-plugins/issues/101)) ([b9e25ad](https://github.com/srobroek/omp-plugins/commit/b9e25ad2b94ec9145a82315d2319b1e11bc2cf58))

## [0.5.3](https://github.com/srobroek/omp-plugins/compare/safety--v0.5.2...safety--v0.5.3) (2026-09-10)


### Bug Fixes

* **safety:** match the unweighted quota notice variant too ([#97](https://github.com/srobroek/omp-plugins/issues/97)) ([a0dd19f](https://github.com/srobroek/omp-plugins/commit/a0dd19fe6aaf92cb48b722e10b16a8cd9cbaeb62))

## [0.5.2](https://github.com/srobroek/omp-plugins/compare/safety--v0.5.1...safety--v0.5.2) (2026-09-10)


### Bug Fixes

* **safety:** keep working after a provider weighted-token quota notice ([#95](https://github.com/srobroek/omp-plugins/issues/95)) ([5553aa7](https://github.com/srobroek/omp-plugins/commit/5553aa72ca95bac9a32a2e86f4f5a699de3ac4ef))

## [0.5.1](https://github.com/srobroek/omp-plugins/compare/safety--v0.5.0...safety--v0.5.1) (2026-09-08)


### Bug Fixes

* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))
* **safety:** preserve literal command data and session boundaries ([7eed995](https://github.com/srobroek/omp-plugins/commit/7eed99586480a9e0dd852c32ecd512f349187c3a))


### Documentation

* clarify plugin safety and usage contracts ([f147fba](https://github.com/srobroek/omp-plugins/commit/f147fbaa08ddae1f5d745defd613b2d33ece4d61))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/safety--v0.4.2...safety--v0.5.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))

## [0.4.2](https://github.com/srobroek/omp-plugins/compare/safety--v0.4.1...safety--v0.4.2) (2026-08-26)


### Bug Fixes

* **safety:** anchor the bash guards in command position, and add a corpus ([7c67cee](https://github.com/srobroek/omp-plugins/commit/7c67cee796cfce17458a358b74f290c87fef2d35))
* **safety:** anchor the bash guards in command position, and add a rule corpus ([c726d5b](https://github.com/srobroek/omp-plugins/commit/c726d5b019bdc2eb3360c1e537308ce1b07fcbfd))

## [0.4.1](https://github.com/srobroek/omp-plugins/compare/safety--v0.4.0...safety--v0.4.1) (2026-08-25)


### Bug Fixes

* **ttsr:** audit wave - retire and re-anchor the blocking rules ([a6ae591](https://github.com/srobroek/omp-plugins/commit/a6ae5911aa0ece0e8af982a43040ae8515970d3a))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/safety--v0.3.0...safety--v0.4.0) (2026-08-25)


### Features

* **safety:** refuse creating a worktree under /tmp ([#21](https://github.com/srobroek/omp-plugins/issues/21)) ([8f2c4ea](https://github.com/srobroek/omp-plugins/commit/8f2c4ea240d3f34cbfdb7a70a5805705431f243a))


### Bug Fixes

* **safety:** exempt the reviewed cleanup idiom from the indirection guard ([#17](https://github.com/srobroek/omp-plugins/issues/17)) ([6eda715](https://github.com/srobroek/omp-plugins/commit/6eda7158e57ae4d3d46f323a27ac4d1ff5e82deb))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/safety--v0.2.0...safety--v0.3.0) (2026-08-25)


### Features

* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/safety--v0.1.0...safety--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))


### Bug Fixes

* **safety:** force-push advisory no longer flags --force-with-lease ([2a07c48](https://github.com/srobroek/omp-plugins/commit/2a07c48065debf3093f937af9a6b366d5d156427))
