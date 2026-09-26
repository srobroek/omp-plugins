# Changelog

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/orchestrate--v0.1.0...orchestrate--v1.0.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **orchestrate:** epic orchestrator integrates workers; shepherd lands epic only ([#572](https://github.com/srobroek/omp-plugins/issues/572))
* orchestrate agents no longer list or call `hub`; the wait-discipline extension is removed; build no longer ships operator; agent output schemas replace `status`/`loop_result` with `verdict`.
* ship the latest orchestrate and beads steering ([#519](https://github.com/srobroek/omp-plugins/issues/519))
* cut worktrunk and beads to store-safety controls and add orchestrate ([#517](https://github.com/srobroek/omp-plugins/issues/517))

### Features

* cut orchestrate over to OMP 18.3 and finish its capability contracts ([fd5831e](https://github.com/srobroek/omp-plugins/commit/fd5831e2ff96ea18950c6809cb98cf93f8888ce1))
* cut worktrunk and beads to store-safety controls and add orchestrate ([#517](https://github.com/srobroek/omp-plugins/issues/517)) ([b5d5771](https://github.com/srobroek/omp-plugins/commit/b5d5771ccd255574bd168c7c147dcd2cfe40d1ab))
* **delivery:** support explicit merge methods in delivery_land ([#580](https://github.com/srobroek/omp-plugins/issues/580)) ([d0bafd3](https://github.com/srobroek/omp-plugins/commit/d0bafd385be3a59a8de9276d74034d6300e48242))
* **omp-plugins-19y3:** keep pool workers waiting ([a01a2ca](https://github.com/srobroek/omp-plugins/commit/a01a2caf3298b05c3680d7b583835e6182ef1988))
* **orchestrate,beads:** fold merger into shepherd, per-agent bd actors, lead yield ([3e81511](https://github.com/srobroek/omp-plugins/commit/3e81511c08cf12dcb26a88525da554be3ab274a6))
* **orchestrate:** epic orchestrator integrates workers; shepherd lands epic only ([#572](https://github.com/srobroek/omp-plugins/issues/572)) ([5e2ae16](https://github.com/srobroek/omp-plugins/commit/5e2ae16d642df8a6f673a565a9f1bde9b1d98f5e))
* **orchestrate:** route workers through claim pools ([d50731f](https://github.com/srobroek/omp-plugins/commit/d50731f3622b29dbe41932c488c0eece11e882f6))
* ship the latest orchestrate and beads steering ([#519](https://github.com/srobroek/omp-plugins/issues/519)) ([add9ed9](https://github.com/srobroek/omp-plugins/commit/add9ed978ae58c98b14606d118c8aa69eb02d1ac))
* **worktrunk:** provision new worktrees in the post-start hook ([#569](https://github.com/srobroek/omp-plugins/issues/569)) ([6890cdf](https://github.com/srobroek/omp-plugins/commit/6890cdf6aca357cfe37ad87d3102ade83abc8507))


### Bug Fixes

* **beads,orchestrate,worktrunk:** prove native leases and fix adherence findings ([6e8fee7](https://github.com/srobroek/omp-plugins/commit/6e8fee7f1a533c429cdfa252360cf37a0b15c482))
* **beads,worktrunk,delivery,orchestrate:** second-wave robustness hardening ([#579](https://github.com/srobroek/omp-plugins/issues/579)) ([ce8a716](https://github.com/srobroek/omp-plugins/commit/ce8a7164f2b0ac98efc7f8291d2aa3fc8643ed4a))
* **beads,worktrunk,orchestrate:** tolerate invalid UTF-8 in preflight subprocesses ([ffe2d7a](https://github.com/srobroek/omp-plugins/commit/ffe2d7a9c5818ce2e48e87c69919103b6475067c))
* **delivery:** close landed beads with native bd instead of bd_reconcile ([#568](https://github.com/srobroek/omp-plugins/issues/568)) ([5f5e4e5](https://github.com/srobroek/omp-plugins/commit/5f5e4e5153d4821f1086f917febc81cca32cf6d1))
* **orchestrate:** align shepherd landing steering ([#577](https://github.com/srobroek/omp-plugins/issues/577)) ([c188466](https://github.com/srobroek/omp-plugins/commit/c188466b0ac18f19f6be6c53d3403a9c1a00243e))
* **orchestrate:** harden preflight and review scheduling ([#581](https://github.com/srobroek/omp-plugins/issues/581)) ([df51c11](https://github.com/srobroek/omp-plugins/commit/df51c11088e89ca61ddeb03c02ce97090dcd696f))
* **orchestrate:** keep the empty omp marker the loader requires ([06cf514](https://github.com/srobroek/omp-plugins/commit/06cf514782028b0b03856782fb4e8e2c84f065fb))
* **orchestrate:** repair conflict review prose ([f64c203](https://github.com/srobroek/omp-plugins/commit/f64c2036da00d5133e006fb653de0e82d0dc2076))
* **orchestrate:** type pool_wait subprocess pipes and drain them while waiting ([3b29fdf](https://github.com/srobroek/omp-plugins/commit/3b29fdfb14219446998008d171172c5714ce5653))
* **preflight:** detect incomplete worktree dependencies ([4d96231](https://github.com/srobroek/omp-plugins/commit/4d96231a02e0402aeb73bcbb11c1d7b167005c16))
* **steering:** document rebasing tracked merges and worktree paths ([#578](https://github.com/srobroek/omp-plugins/issues/578)) ([0580cd5](https://github.com/srobroek/omp-plugins/commit/0580cd50c46224a85abd92bd289e67504bce0b0b))


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))
* **orchestrate:** send integration conflicts to implementers ([#573](https://github.com/srobroek/omp-plugins/issues/573)) ([756e449](https://github.com/srobroek/omp-plugins/commit/756e4495bd56428f6f202b7cc209cd1a5814b556))
