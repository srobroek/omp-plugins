# Changelog

## [1.4.0](https://github.com/srobroek/project-setup/compare/lang-python-v1.3.0...lang-python--v1.4.0) (2026-07-03)


### Features

* adopt the double-dash release-tag convention across all components ([d2508e2](https://github.com/srobroek/project-setup/commit/d2508e27914bfa0457ced6340f4b9d49187acfbb))

## [1.3.0](https://github.com/srobroek/project-setup/compare/lang-python-v1.2.1...lang-python-v1.3.0) (2026-07-01)


### Features

* thin bundled skill to 6 core modules, move 18 addons to catalog/modules/ ([b0ea14b](https://github.com/srobroek/project-setup/commit/b0ea14ba5450b99f9594d7b7adbd1d5ace9b096c))
* thin the bundled skill to 6 core modules; fetch the rest from the catalog ([d26f9d2](https://github.com/srobroek/project-setup/commit/d26f9d24fc33e52de643ebb73acc32a650ae7967))

## [1.2.1](https://github.com/srobroek/project-setup/compare/lang-python-v1.2.0...lang-python-v1.2.1) (2026-06-30)


### Bug Fixes

* deterministic scaffolding — correct package identity, installable manifests, valid CI, enforced interview ([fed956f](https://github.com/srobroek/project-setup/commit/fed956f22f978804b5f4ffece839c85e4e8b9324))
* **lang-python:** name package from project_name answer; installable build-system; sync description ([f3f24e7](https://github.com/srobroek/project-setup/commit/f3f24e727084dd2e2e18f759470ac352ac3e99b9))

## [1.2.0](https://github.com/srobroek/project-setup/compare/lang-python-v1.1.1...lang-python-v1.2.0) (2026-06-30)


### Features

* **lang-python:** accept pre-resolved pinned_deps/dev_deps/ruff_version as optional inputs ([00510cc](https://github.com/srobroek/project-setup/commit/00510cca8a157f95c0ab9b2942e6807ff4a6b22a))


### Bug Fixes

* pre-resolved deps now materialize, inert gate flags warn, version drift guarded ([710115b](https://github.com/srobroek/project-setup/commit/710115b0c9c08cce0b906b9db039c241497040f1))
* use release-please generic updater so module/apm versions actually sync ([c132244](https://github.com/srobroek/project-setup/commit/c132244f0704238bcee20909258336beb2bac9e1))
* version metadata now syncs on release (generic updater) ([3507f61](https://github.com/srobroek/project-setup/commit/3507f61331d9bb7be9dc91a33ff9a89d8c1e3e6d))

## [1.1.1](https://github.com/srobroek/project-setup/compare/lang-python-v1.1.0...lang-python-v1.1.1) (2026-06-29)


### Bug Fixes

* **lang-python:** convert @ pin format to PEP 508 == in pyproject.toml ([85f03a8](https://github.com/srobroek/project-setup/commit/85f03a8b757ef93c66acafa7f4c267a06d2519ba))
* project-local frozen plan, answers-file consent flags, PEP 508 pin rendering ([6533724](https://github.com/srobroek/project-setup/commit/6533724880c29cc46434c78add17c6a54df26d14))

## [1.1.0](https://github.com/srobroek/project-setup/compare/lang-python-v1.0.0...lang-python-v1.1.0) (2026-06-29)


### Features

* initial standalone project-setup — agent-driven scaffolding runner + git-distributed add-on modules ([37a280a](https://github.com/srobroek/project-setup/commit/37a280a0174d5b85305b003f659cd9931d5e8821))
