# Changelog

## [1.4.0](https://github.com/srobroek/project-setup/compare/lang-ts-v1.3.0...lang-ts--v1.4.0) (2026-07-03)


### Features

* adopt the double-dash release-tag convention across all components ([d2508e2](https://github.com/srobroek/project-setup/commit/d2508e27914bfa0457ced6340f4b9d49187acfbb))

## [1.3.0](https://github.com/srobroek/project-setup/compare/lang-ts-v1.2.1...lang-ts-v1.3.0) (2026-07-01)


### Features

* thin bundled skill to 6 core modules, move 18 addons to catalog/modules/ ([b0ea14b](https://github.com/srobroek/project-setup/commit/b0ea14ba5450b99f9594d7b7adbd1d5ace9b096c))
* thin the bundled skill to 6 core modules; fetch the rest from the catalog ([d26f9d2](https://github.com/srobroek/project-setup/commit/d26f9d24fc33e52de643ebb73acc32a650ae7967))

## [1.2.1](https://github.com/srobroek/project-setup/compare/lang-ts-v1.2.0...lang-ts-v1.2.1) (2026-06-30)


### Bug Fixes

* deterministic scaffolding — correct package identity, installable manifests, valid CI, enforced interview ([fed956f](https://github.com/srobroek/project-setup/commit/fed956f22f978804b5f4ffece839c85e4e8b9324))
* **lang-ts:** set package.json name from project_name answer ([1b07675](https://github.com/srobroek/project-setup/commit/1b076756c4f98d5a95cab2796c68ebfe0047c81a))

## [1.2.0](https://github.com/srobroek/project-setup/compare/lang-ts-v1.1.0...lang-ts-v1.2.0) (2026-06-30)


### Features

* **lang-ts:** accept pre-resolved pinned_deps/dev_deps/package_manager_pin as optional inputs ([2a23cc2](https://github.com/srobroek/project-setup/commit/2a23cc20bb189c4c5a473d10dc5a02b87ec70f2b))


### Bug Fixes

* pre-resolved deps now materialize, inert gate flags warn, version drift guarded ([710115b](https://github.com/srobroek/project-setup/commit/710115b0c9c08cce0b906b9db039c241497040f1))
* use release-please generic updater so module/apm versions actually sync ([c132244](https://github.com/srobroek/project-setup/commit/c132244f0704238bcee20909258336beb2bac9e1))
* version metadata now syncs on release (generic updater) ([3507f61](https://github.com/srobroek/project-setup/commit/3507f61331d9bb7be9dc91a33ff9a89d8c1e3e6d))

## [1.1.0](https://github.com/srobroek/project-setup/compare/lang-ts-v1.0.0...lang-ts-v1.1.0) (2026-06-29)


### Features

* initial standalone project-setup — agent-driven scaffolding runner + git-distributed add-on modules ([37a280a](https://github.com/srobroek/project-setup/commit/37a280a0174d5b85305b003f659cd9931d5e8821))
