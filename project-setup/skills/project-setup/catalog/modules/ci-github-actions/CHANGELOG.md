# Changelog

## [1.3.0](https://github.com/srobroek/project-setup/compare/ci-github-actions-v1.2.0...ci-github-actions--v1.3.0) (2026-07-03)


### Features

* adopt the double-dash release-tag convention across all components ([d2508e2](https://github.com/srobroek/project-setup/commit/d2508e27914bfa0457ced6340f4b9d49187acfbb))

## [1.2.0](https://github.com/srobroek/project-setup/compare/ci-github-actions-v1.1.3...ci-github-actions-v1.2.0) (2026-07-01)


### Features

* thin bundled skill to 6 core modules, move 18 addons to catalog/modules/ ([b0ea14b](https://github.com/srobroek/project-setup/commit/b0ea14ba5450b99f9594d7b7adbd1d5ace9b096c))
* thin the bundled skill to 6 core modules; fetch the rest from the catalog ([d26f9d2](https://github.com/srobroek/project-setup/commit/d26f9d24fc33e52de643ebb73acc32a650ae7967))

## [1.1.3](https://github.com/srobroek/project-setup/compare/ci-github-actions-v1.1.2...ci-github-actions-v1.1.3) (2026-06-30)


### Bug Fixes

* **ci-github-actions:** render YAML via one recursive emitter; structural FIXME header ([e07e5b0](https://github.com/srobroek/project-setup/commit/e07e5b07d062421cc229b77907c309c56a9dfb58))
* harden CI YAML renderer (single recursive emitter) and make go.mod version configurable ([7aa2b77](https://github.com/srobroek/project-setup/commit/7aa2b77317e740d81e79d9a9bdc340a0efc71cca))

## [1.1.2](https://github.com/srobroek/project-setup/compare/ci-github-actions-v1.1.1...ci-github-actions-v1.1.2) (2026-06-30)


### Bug Fixes

* **ci-github-actions:** emit valid with: YAML mapping; install just; warn on empty plan ([77a2043](https://github.com/srobroek/project-setup/commit/77a2043754159956ab78964f80d38dae5971f5ad))
* deterministic scaffolding — correct package identity, installable manifests, valid CI, enforced interview ([fed956f](https://github.com/srobroek/project-setup/commit/fed956f22f978804b5f4ffece839c85e4e8b9324))

## [1.1.2](https://github.com/srobroek/project-setup/compare/ci-github-actions-v1.1.1...ci-github-actions-v1.1.2) (2026-06-30)


### Bug Fixes

* **ci-github-actions:** emit valid with: YAML mapping; install just; warn on empty plan ([77a2043](https://github.com/srobroek/project-setup/commit/77a2043754159956ab78964f80d38dae5971f5ad))
* deterministic scaffolding — correct package identity, installable manifests, valid CI, enforced interview ([fed956f](https://github.com/srobroek/project-setup/commit/fed956f22f978804b5f4ffece839c85e4e8b9324))

## [1.1.1](https://github.com/srobroek/project-setup/compare/ci-github-actions-v1.1.0...ci-github-actions-v1.1.1) (2026-06-30)


### Bug Fixes

* pre-resolved deps now materialize, inert gate flags warn, version drift guarded ([710115b](https://github.com/srobroek/project-setup/commit/710115b0c9c08cce0b906b9db039c241497040f1))
* use release-please generic updater so module/apm versions actually sync ([c132244](https://github.com/srobroek/project-setup/commit/c132244f0704238bcee20909258336beb2bac9e1))
* version metadata now syncs on release (generic updater) ([3507f61](https://github.com/srobroek/project-setup/commit/3507f61331d9bb7be9dc91a33ff9a89d8c1e3e6d))

## [1.1.0](https://github.com/srobroek/project-setup/compare/ci-github-actions-v1.0.0...ci-github-actions-v1.1.0) (2026-06-29)


### Features

* initial standalone project-setup — agent-driven scaffolding runner + git-distributed add-on modules ([37a280a](https://github.com/srobroek/project-setup/commit/37a280a0174d5b85305b003f659cd9931d5e8821))
