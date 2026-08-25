# Changelog

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/beads--v0.6.0...beads--v0.6.1) (2026-08-25)


### Bug Fixes

* **beads:** storage-mode notice fires once across module instances ([eec8571](https://github.com/srobroek/omp-plugins/commit/eec8571deb0b7e4afe6f49b4e324d47140f5408b))
* **beads:** storage-mode notice fires once across module instances ([eb1d981](https://github.com/srobroek/omp-plugins/commit/eb1d9815990d8db2c738305396d64c17ac606e9f))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))
* **speckit:** retire the spec-id TTSR as a contextual false positive ([76caeec](https://github.com/srobroek/omp-plugins/commit/76caeec135b0b1943b6df551578cd6b6e7facd1b))
* **ttsr:** audit wave - retire and re-anchor the blocking rules ([a6ae591](https://github.com/srobroek/omp-plugins/commit/a6ae5911aa0ece0e8af982a43040ae8515970d3a))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.5.0...beads--v0.6.0) (2026-08-25)


### Features

* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.4.0...beads--v0.5.0) (2026-08-25)


### Features

* **beads:** own the gate-close guard, and make it watertight ([7663271](https://github.com/srobroek/omp-plugins/commit/7663271c1ff654e47897a96e72e60e2d8db75d47))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.3.0...beads--v0.4.0) (2026-08-25)


### Features

* **authoring:** lint machine-specific paths and unrepairable frontmatter ([2803c30](https://github.com/srobroek/omp-plugins/commit/2803c30b780c763c039ce2f753b8e4174b83aa74))
* **authoring:** lint machine-specific paths and unrepairable frontmatter ([a456af3](https://github.com/srobroek/omp-plugins/commit/a456af3e109c44d1ad1dfbed2078b0a0b8202ccd))
* **beads:** guard the two bd commands that strand or overwrite a run ([309f154](https://github.com/srobroek/omp-plugins/commit/309f1545ff2a2316c05ce254d23037ef869d571d))
* **beads:** guard the two bd commands that strand or overwrite a run ([3d8e6ec](https://github.com/srobroek/omp-plugins/commit/3d8e6ecbea321aa6007ee2760a5237e93413d731))
* **beads:** make an agent triage the pre-existing problems it runs into ([a124a79](https://github.com/srobroek/omp-plugins/commit/a124a79d2b3fff29d7540817e620f7f9b62509f3))
* **beads:** make an agent triage the pre-existing problems it runs into ([93cc493](https://github.com/srobroek/omp-plugins/commit/93cc49318936aecea664925d28b42b87a6e227a4))
* **beads:** make server mode the documented init default ([67a8530](https://github.com/srobroek/omp-plugins/commit/67a85309edfa48de61b922a3f91f1b89ca03be3c))
* **beads:** refresh project memories at session start and after compaction ([477ded9](https://github.com/srobroek/omp-plugins/commit/477ded972309014ebe1e1a3db82b77cce0738259))
* **beads:** session lifecycle extension + four TTSR guards ([9300c07](https://github.com/srobroek/omp-plugins/commit/9300c07a5847262c2870dad5bf368fdc106db5d6))
* **beads:** steer storage mode and manage the Dolt server under omp ([bb9ff4e](https://github.com/srobroek/omp-plugins/commit/bb9ff4ecbdddfe3e07d459257a728bcb39a562c6))
* **beads:** steer storage mode and manage the Dolt server under omp ([0c0249d](https://github.com/srobroek/omp-plugins/commit/0c0249ddd6d7fb879f558ed290a440fdc4791d53))
* **speckit:** recover spec-modes rule lost in the docs rollup ([84c01b8](https://github.com/srobroek/omp-plugins/commit/84c01b85067a877cd2ab4d20c0bfeca88934aa0d))


### Bug Fixes

* **beads:** verify the dolt stop instead of reporting what bd claimed ([18276ed](https://github.com/srobroek/omp-plugins/commit/18276ed3b779496f8bb952dbf05093505fe229be))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.2.0...beads--v0.3.0) (2026-08-25)


### Features

* **beads,delivery:** claim-without-actor gate and unpushed-work stop advisory ([6d68bf2](https://github.com/srobroek/omp-plugins/commit/6d68bf2d9a5d570a9facbad2b2a31823f14fa43e))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.1.0...beads--v0.2.0) (2026-08-25)


### Features

* migrate the APM estate into 31 OMP plugins ([d34f30c](https://github.com/srobroek/omp-plugins/commit/d34f30cb4b193ae26c0baf9dc75564502ea7c646))
* native tools everywhere, 23-plugin consolidation, full test coverage ([ed5dfca](https://github.com/srobroek/omp-plugins/commit/ed5dfcadbaa6393f9d979ee26c7154dc742aa964))
* per-package optimisation pass onto OMP-native constructs ([afdadc5](https://github.com/srobroek/omp-plugins/commit/afdadc5ad536b883db2b4dd919c992a1ed71c7d2))
* work the migration backlog — speckit and project-setup plugins, TTSR adoptions, discovery tools ([90cae47](https://github.com/srobroek/omp-plugins/commit/90cae47f11df265138b099dcf1825daa14a22da0))
