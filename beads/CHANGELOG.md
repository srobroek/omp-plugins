# Changelog

## [2.1.0](https://github.com/srobroek/omp-plugins/compare/beads--v2.0.4...beads--v2.1.0) (2026-09-21)


### Features

* **project-setup:** replace scaffold runtime ([#436](https://github.com/srobroek/omp-plugins/issues/436)) ([f8fd91b](https://github.com/srobroek/omp-plugins/commit/f8fd91b75ec57d667a209ba68c771a04c0501464))

## [2.0.4](https://github.com/srobroek/omp-plugins/compare/beads--v2.0.3...beads--v2.0.4) (2026-09-20)


### Bug Fixes

* **beads:** remove dead shared-server credential steering ([#432](https://github.com/srobroek/omp-plugins/issues/432)) ([0f01cd5](https://github.com/srobroek/omp-plugins/commit/0f01cd5732667a4a6e5c563075a9574914fc28ff))
* **beads:** say why the prune gate also stops lossless compaction ([#431](https://github.com/srobroek/omp-plugins/issues/431)) ([bd837d8](https://github.com/srobroek/omp-plugins/commit/bd837d814c252d8be23e66dc333a4d40052d565b))


### Documentation

* **beads:** add storage-maintenance steering ([#430](https://github.com/srobroek/omp-plugins/issues/430)) ([1cedb68](https://github.com/srobroek/omp-plugins/commit/1cedb68534e3393d0f6a49c06dc9230fa45527a3))

## [2.0.3](https://github.com/srobroek/omp-plugins/compare/beads--v2.0.2...beads--v2.0.3) (2026-09-19)


### Bug Fixes

* **beads:** centralize shell gate parsing ([#411](https://github.com/srobroek/omp-plugins/issues/411)) ([9215f03](https://github.com/srobroek/omp-plugins/commit/9215f033d76f945e9258852e17733d3217a68f80))
* **beads:** complete lifecycle and formula leftovers ([#423](https://github.com/srobroek/omp-plugins/issues/423)) ([0ee770d](https://github.com/srobroek/omp-plugins/commit/0ee770d5a5063f13c0355113cf25ab2c2a495613))
* bound agentic lint traversal ([#414](https://github.com/srobroek/omp-plugins/issues/414)) ([edb9156](https://github.com/srobroek/omp-plugins/commit/edb91562ff82e0b59d119e22a32890231b301cc6))


### Refactors

* **beads:** remove Dolt server steering; document embedded store ([#409](https://github.com/srobroek/omp-plugins/issues/409)) ([5aa3e39](https://github.com/srobroek/omp-plugins/commit/5aa3e398cf8520bd4bc40c40e27ac7d2f4248983))


### Documentation

* **beads:** require durable carriers for bead evidence ([#420](https://github.com/srobroek/omp-plugins/issues/420)) ([70d2f2e](https://github.com/srobroek/omp-plugins/commit/70d2f2edb193f6b133225d05f67bf3e2df7fd1b9))
* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))
* trim duplicated steering contracts ([#413](https://github.com/srobroek/omp-plugins/issues/413)) ([2176376](https://github.com/srobroek/omp-plugins/commit/2176376e4968fed8879409085a9973bf95bb77b8))

## [2.0.2](https://github.com/srobroek/omp-plugins/compare/beads--v2.0.1...beads--v2.0.2) (2026-09-19)


### Bug Fixes

* **beads:** fail closed on unknown repository permission ([#400](https://github.com/srobroek/omp-plugins/issues/400)) ([e65c614](https://github.com/srobroek/omp-plugins/commit/e65c6144254bbe1bb6030b8fe3315fc4f1c53f94))
* **beads:** one shared shell tokenizer, and close two gate fail-opens ([#402](https://github.com/srobroek/omp-plugins/issues/402)) ([264facb](https://github.com/srobroek/omp-plugins/commit/264facb1ac2a07a53f3dd668fdf98d6b8443ec1c))

## [2.0.1](https://github.com/srobroek/omp-plugins/compare/beads--v2.0.0...beads--v2.0.1) (2026-09-19)


### Bug Fixes

* **beads:** ignore retired ledgers in PR gate ([c171c80](https://github.com/srobroek/omp-plugins/commit/c171c80295ca8feb19eff6bbd283a65d3347c2d5))

## [2.0.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.7.3...beads--v2.0.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* **beads:** remove Dolt server policy surfaces ([#396](https://github.com/srobroek/omp-plugins/issues/396))

### Features

* **beads:** remove Dolt server policy surfaces ([#396](https://github.com/srobroek/omp-plugins/issues/396)) ([831467e](https://github.com/srobroek/omp-plugins/commit/831467eb815b4237991fd64d2df5bd7b6e0eebc3))

## [1.7.3](https://github.com/srobroek/omp-plugins/compare/beads--v1.7.2...beads--v1.7.3) (2026-09-19)


### Bug Fixes

* **beads:** allow truthful no-bead PR trailers ([f0b0641](https://github.com/srobroek/omp-plugins/commit/f0b06419d7b9a25099297fbe4c2cc8ca0cb33d38))

## [1.7.2](https://github.com/srobroek/omp-plugins/compare/beads--v1.7.1...beads--v1.7.2) (2026-09-18)


### Bug Fixes

* **beads:** give session lifecycle bd calls the server credential ([#376](https://github.com/srobroek/omp-plugins/issues/376)) ([973a689](https://github.com/srobroek/omp-plugins/commit/973a68964f3363eb39ac17268fbe3109e17198f1))

## [1.7.1](https://github.com/srobroek/omp-plugins/compare/beads--v1.7.0...beads--v1.7.1) (2026-09-18)


### Bug Fixes

* **beads:** refuse a concurrent dolt server start ([#368](https://github.com/srobroek/omp-plugins/issues/368)) ([82d794c](https://github.com/srobroek/omp-plugins/commit/82d794cabe032b967564e30e5d9c4b84f812dc89))

## [1.7.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.6.0...beads--v1.7.0) (2026-09-18)


### Features

* **beads:** restore a reclaimed merge slot to its owner ([#365](https://github.com/srobroek/omp-plugins/issues/365)) ([d2962b0](https://github.com/srobroek/omp-plugins/commit/d2962b00ece33d3eb0dd20600b6522e11ec3d981))

## [1.6.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.5.2...beads--v1.6.0) (2026-09-18)


### Features

* **beads:** enforce pool and reclaim phase discipline ([#363](https://github.com/srobroek/omp-plugins/issues/363)) ([828e2c3](https://github.com/srobroek/omp-plugins/commit/828e2c3d3c8f5f6810ddabf90467747f28295ff3))

## [1.5.2](https://github.com/srobroek/omp-plugins/compare/beads--v1.5.1...beads--v1.5.2) (2026-09-18)


### Bug Fixes

* **beads:** anchor computed claim ids ([#361](https://github.com/srobroek/omp-plugins/issues/361)) ([6ea6cd1](https://github.com/srobroek/omp-plugins/commit/6ea6cd182a722991baa7bd357f3ff449271cad8f))

## [1.5.1](https://github.com/srobroek/omp-plugins/compare/beads--v1.5.0...beads--v1.5.1) (2026-09-18)


### Bug Fixes

* **beads:** read argv for the claim-before-branch trigger ([#358](https://github.com/srobroek/omp-plugins/issues/358)) ([3c2a18b](https://github.com/srobroek/omp-plugins/commit/3c2a18b00080d7738d447bbf22dbae439e5f9f39))

## [1.5.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.4.1...beads--v1.5.0) (2026-09-18)


### Features


## [1.4.1](https://github.com/srobroek/omp-plugins/compare/beads--v1.4.0...beads--v1.4.1) (2026-09-17)


### Bug Fixes

* **beads:** explain unreadable session claims ([#345](https://github.com/srobroek/omp-plugins/issues/345)) ([787c4da](https://github.com/srobroek/omp-plugins/commit/787c4da4215fae3fc198a9b4b0a828ffd0c3d72b))
* **beads:** release a session's claims at shutdown and expose lease anchors ([#347](https://github.com/srobroek/omp-plugins/issues/347)) ([289f5c6](https://github.com/srobroek/omp-plugins/commit/289f5c646a53e4242eeb74fa6730af3b427f6185))
* **beads:** scope session pins to their repository ([#340](https://github.com/srobroek/omp-plugins/issues/340)) ([6ef5528](https://github.com/srobroek/omp-plugins/commit/6ef5528ce5d933825ad98244212fe606f5058d70))

## [1.4.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.3.6...beads--v1.4.0) (2026-09-16)


### Features

* **session:** wake parents on settled task batches and release stale claims by evidence ([#330](https://github.com/srobroek/omp-plugins/issues/330)) ([47aa331](https://github.com/srobroek/omp-plugins/commit/47aa33155c04aa4124c1f0dbd736f28e8267df2c))


### Bug Fixes

* **beads:** ignore the host gate lock and drop the Unicode dash from beads-core ([#333](https://github.com/srobroek/omp-plugins/issues/333)) ([d5165f2](https://github.com/srobroek/omp-plugins/commit/d5165f2b3259f770491e04154477a3f9b2c4c410))

## [1.3.6](https://github.com/srobroek/omp-plugins/compare/beads--v1.3.5...beads--v1.3.6) (2026-09-16)


### Bug Fixes

* **beads:** use specific reference wording ([1d24415](https://github.com/srobroek/omp-plugins/commit/1d2441598f0f0c218c6bf32f6e121229963e673d))
* **beads:** use specific reference wording ([a98786b](https://github.com/srobroek/omp-plugins/commit/a98786bcd6bffe5c17aa2e374584ba355a7c6628))

## [1.3.5](https://github.com/srobroek/omp-plugins/compare/beads--v1.3.4...beads--v1.3.5) (2026-09-16)


### Bug Fixes

* **beads:** clarify referenced work item reporting ([6681c2c](https://github.com/srobroek/omp-plugins/commit/6681c2c9f1df32354b3d625bdaabad82ba0869f6))

## [1.3.4](https://github.com/srobroek/omp-plugins/compare/beads--v1.3.3...beads--v1.3.4) (2026-09-15)


### Bug Fixes

* **beads:** enforce PR bead linkage for controlled repositories ([#293](https://github.com/srobroek/omp-plugins/issues/293)) ([83dbc54](https://github.com/srobroek/omp-plugins/commit/83dbc544b0e8548b953f949f7e516e8d415cd550))

## [1.3.3](https://github.com/srobroek/omp-plugins/compare/beads--v1.3.2...beads--v1.3.3) (2026-09-15)


### Bug Fixes

* **delivery:** trust remote steering sources ([ce43658](https://github.com/srobroek/omp-plugins/commit/ce43658be90aa22656fd973b2daf05c8e0400a4e))

## [1.3.2](https://github.com/srobroek/omp-plugins/compare/beads--v1.3.1...beads--v1.3.2) (2026-09-14)


### Bug Fixes

* **beads:** bind both actor env names on release ([69ebdd3](https://github.com/srobroek/omp-plugins/commit/69ebdd3aa1d0f3773813de3939751ea5be92902d))
* **beads:** bind canonical actor on release commands ([756ac12](https://github.com/srobroek/omp-plugins/commit/756ac12d848b0406754bccb90cb92dfdf9f49ae4))
* **beads:** require dual actor binding in release guidance ([4001677](https://github.com/srobroek/omp-plugins/commit/40016772e15d808790d56f9b5792789107d70f14))

## [1.3.1](https://github.com/srobroek/omp-plugins/compare/beads--v1.3.0...beads--v1.3.1) (2026-09-14)


### Bug Fixes

* **beads:** attribute guarded claim releases ([3a26640](https://github.com/srobroek/omp-plugins/commit/3a26640c81f31b037dc2d372bc356f4475c28ae4))
* **beads:** attribute guarded claim releases ([80febee](https://github.com/srobroek/omp-plugins/commit/80febee7b3bbdde6591bd6a4ffe1ae7a28abfd98))
* **beads:** bind release command actor ([3de26ba](https://github.com/srobroek/omp-plugins/commit/3de26bae06c634e535dfa4eb74e529dc41a1fcd8))
* **beads:** guard release attribution by CLI capability ([55e266f](https://github.com/srobroek/omp-plugins/commit/55e266f604de709328f1c11881ccfebf37d532f5))
* **beads:** require actor to match claim holder ([3ccbf8e](https://github.com/srobroek/omp-plugins/commit/3ccbf8e7159e944fe5ee15183c35e222d0d00da5))
* **beads:** satisfy import ordering check ([8616083](https://github.com/srobroek/omp-plugins/commit/861608387b393a74eb2af62b828804230167dd52))
* **beads:** satisfy lifecycle checks ([00121b1](https://github.com/srobroek/omp-plugins/commit/00121b1b847b4afbf2cdac1518733452af83ca41))
* **beads:** wire guarded release advisory ([6783557](https://github.com/srobroek/omp-plugins/commit/6783557647f427d775346a4fd845c2db38f41d8e))


### Documentation

* **beads:** require release flag capability check ([9083d9e](https://github.com/srobroek/omp-plugins/commit/9083d9eacdd87fd8b89447730cf409bc621ad825))

## [1.3.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.2.5...beads--v1.3.0) (2026-09-14)


### Features


## [1.2.5](https://github.com/srobroek/omp-plugins/compare/beads--v1.2.4...beads--v1.2.5) (2026-09-13)


### Refactors

* **beads:** apply the rules audit ([#252](https://github.com/srobroek/omp-plugins/issues/252)) ([129a5f8](https://github.com/srobroek/omp-plugins/commit/129a5f8e972f89abe35e1985394363f5ede37670))

## [1.2.4](https://github.com/srobroek/omp-plugins/compare/beads--v1.2.3...beads--v1.2.4) (2026-09-13)


### Bug Fixes

* **beads:** surface lease stamp failures ([#242](https://github.com/srobroek/omp-plugins/issues/242)) ([c08e073](https://github.com/srobroek/omp-plugins/commit/c08e07392136bfa17e6e158e0061ce0fee589e37))

## [1.2.3](https://github.com/srobroek/omp-plugins/compare/beads--v1.2.2...beads--v1.2.3) (2026-09-13)


### Bug Fixes

* **beads:** stop the triage rule firing on ownership and quoted scope statements ([#244](https://github.com/srobroek/omp-plugins/issues/244)) ([11422a3](https://github.com/srobroek/omp-plugins/commit/11422a3b5591449bb87b7a4eeb7ae24199042170))

## [1.2.2](https://github.com/srobroek/omp-plugins/compare/beads--v1.2.1...beads--v1.2.2) (2026-09-12)


### Bug Fixes

* **beads:** prefer primary store in linked worktrees ([#232](https://github.com/srobroek/omp-plugins/issues/232)) ([f4294a8](https://github.com/srobroek/omp-plugins/commit/f4294a89da49c464257fbfa2cfdea1aad7da9de0))

## [1.2.1](https://github.com/srobroek/omp-plugins/compare/beads--v1.2.0...beads--v1.2.1) (2026-09-12)


### Bug Fixes

* ignore reported handoffs in session claim guard ([#230](https://github.com/srobroek/omp-plugins/issues/230)) ([8669abe](https://github.com/srobroek/omp-plugins/commit/8669abe16e6af0966a272ac47eb0a6dac58b73ff))

## [1.2.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.1.0...beads--v1.2.0) (2026-09-12)

Released by hand: the two merges below landed with prose squash subjects, so
release-please attributed nothing and opened no release PR.

### Features

* **beads:** prove bead ownership by lease and require PR linkage ([#221](https://github.com/srobroek/omp-plugins/issues/221)) ([435b8a3](https://github.com/srobroek/omp-plugins/commit/435b8a3d2d99a554db967de3e464e245b412d27f))
* **beads:** document the lease and PR-linkage gates ([#225](https://github.com/srobroek/omp-plugins/issues/225)) ([190bd80](https://github.com/srobroek/omp-plugins/commit/190bd80dcc0b4840acc69771489f6fc759ec203b))

## [1.1.0](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.15...beads--v1.1.0) (2026-09-12)


### Features

* **beads:** fire when a branch is created for an unclaimed bead ([#222](https://github.com/srobroek/omp-plugins/issues/222)) ([af18695](https://github.com/srobroek/omp-plugins/commit/af186950f807739baac6786572bdcf1d7395e40d))


### Bug Fixes

* **beads:** resolve one effective actor per bd invocation, BD_ACTOR first ([b0c10cd](https://github.com/srobroek/omp-plugins/commit/b0c10cd63252974f159e4349b5c899a7e2ebbfc6))
* **beads:** resolve one effective actor per bd invocation, BD_ACTOR first ([26b08da](https://github.com/srobroek/omp-plugins/commit/26b08dad291d83c84adf2bf466a18cfa6c74bfc5))

## [1.0.15](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.14...beads--v1.0.15) (2026-09-11)


### Bug Fixes

* **beads:** release a claim with a command bd actually has ([#198](https://github.com/srobroek/omp-plugins/issues/198)) ([1993a25](https://github.com/srobroek/omp-plugins/commit/1993a25cf9ae0b0d3e0da85243c57f9a9b276454))

## [1.0.14](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.13...beads--v1.0.14) (2026-09-11)


### Bug Fixes

* repair the secret-commit guard's cwd model and the beads backend resolver ([#169](https://github.com/srobroek/omp-plugins/issues/169)) ([d8c3c85](https://github.com/srobroek/omp-plugins/commit/d8c3c8520e9b8a96aafe1f42505af49bd31cd370))

## [1.0.13](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.12...beads--v1.0.13) (2026-09-11)


### Bug Fixes

* **beads:** refuse an actorless bd create, including its aliases ([#165](https://github.com/srobroek/omp-plugins/issues/165)) ([a3a8ade](https://github.com/srobroek/omp-plugins/commit/a3a8ade5166292d533adbfdf8369e07cae93a25b))

## [1.0.12](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.11...beads--v1.0.12) (2026-09-11)


### Bug Fixes

* **beads:** keep deep formula checks on the configured approval policy ([f1d460e](https://github.com/srobroek/omp-plugins/commit/f1d460e7238a2eb8f15bc5e255b92c47067a973b))
* remediate confirmed sniff-audit findings and make the strict TypeScript + Biome contract pass ([5ecdd5f](https://github.com/srobroek/omp-plugins/commit/5ecdd5f027fa8f07f4eb9a2b10e93532b6e129d3))

## [1.0.11](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.10...beads--v1.0.11) (2026-09-10)


### Documentation

* **beads:** the plugin pins BEADS_DIR; agents must not demand an export ([#144](https://github.com/srobroek/omp-plugins/issues/144)) ([b27e33b](https://github.com/srobroek/omp-plugins/commit/b27e33b3c65ce529caf00dd1fa5c4e4872ad08b5))

## [1.0.10](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.9...beads--v1.0.10) (2026-09-10)


### Documentation

* **beads:** the plugin pins BEADS_DIR; agents must not demand an export ([#141](https://github.com/srobroek/omp-plugins/issues/141)) ([179cf69](https://github.com/srobroek/omp-plugins/commit/179cf690761d8c91d54829ac13e125d15de69b2a))

## [1.0.9](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.8...beads--v1.0.9) (2026-09-10)


### Bug Fixes

* **beads:** a linked worktree pins to the primary checkout's database ([#139](https://github.com/srobroek/omp-plugins/issues/139)) ([6def97d](https://github.com/srobroek/omp-plugins/commit/6def97d94593885de18e985c0c45e4d74e88b298))

## [1.0.8](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.7...beads--v1.0.8) (2026-09-10)


### Bug Fixes

* **beads:** per-call pin honors a foreign process pin ([#137](https://github.com/srobroek/omp-plugins/issues/137)) ([8b318be](https://github.com/srobroek/omp-plugins/commit/8b318be909965ebd956096f090deaf02815bdf69))

## [1.0.7](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.6...beads--v1.0.7) (2026-09-10)


### Bug Fixes

* **beads:** pin BEADS_DIR on every bash call, not only on process.env ([#135](https://github.com/srobroek/omp-plugins/issues/135)) ([c6dfe5f](https://github.com/srobroek/omp-plugins/commit/c6dfe5f22d06a2144f2cb13ee2711256e0acb04e))

## [1.0.6](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.5...beads--v1.0.6) (2026-09-10)


### Bug Fixes

* **beads,agentic-scaffold:** pin BEADS_DIR automatically and survive a mid-session plugin upgrade ([#129](https://github.com/srobroek/omp-plugins/issues/129)) ([0dc7658](https://github.com/srobroek/omp-plugins/commit/0dc76589969ec18c0efd6bd17ce34eabb31ff894))

## [1.0.5](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.4...beads--v1.0.5) (2026-09-10)


### Documentation

* route public GitHub sync through PATH shims ([#86](https://github.com/srobroek/omp-plugins/issues/86)) ([163f958](https://github.com/srobroek/omp-plugins/commit/163f958a7bef61ba4c46f4a40f31996084ba3757))

## [1.0.4](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.3...beads--v1.0.4) (2026-09-09)


### Bug Fixes

* **beads:** classify and arbitrate bd actor writes ([#80](https://github.com/srobroek/omp-plugins/issues/80)) ([d6dc2bd](https://github.com/srobroek/omp-plugins/commit/d6dc2bd47df753a0a1f4d77e811d430352c0594c))

## [1.0.3](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.2...beads--v1.0.3) (2026-09-09)


### Bug Fixes

* **beads:** read here-document bodies as data in the bd gates ([#78](https://github.com/srobroek/omp-plugins/issues/78)) ([534c983](https://github.com/srobroek/omp-plugins/commit/534c983f8193d9b457603487a2b11bc056705041))

## [1.0.2](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.1...beads--v1.0.2) (2026-09-09)


### Bug Fixes

* **beads:** honour an exported BEADS_ACTOR earlier on the command line ([#75](https://github.com/srobroek/omp-plugins/issues/75)) ([6158b25](https://github.com/srobroek/omp-plugins/commit/6158b25fcb405517e0438e5c1cbf150ca6e44908))

## [1.0.1](https://github.com/srobroek/omp-plugins/compare/beads--v1.0.0...beads--v1.0.1) (2026-09-08)


### Bug Fixes

* **beads:** accept null empty gate lists ([#70](https://github.com/srobroek/omp-plugins/issues/70)) ([2b09895](https://github.com/srobroek/omp-plugins/commit/2b0989599a69f379ef02ca61678a6d75ae0d82ad))

## [1.0.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.8.1...beads--v1.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* Drop support for APM formats and sidecar agent contracts.

### Features

* retire APM formats and add staged lint ([#68](https://github.com/srobroek/omp-plugins/issues/68)) ([07996f1](https://github.com/srobroek/omp-plugins/commit/07996f115baddbe4261ce6892100238bff2310bd))

## [0.8.1](https://github.com/srobroek/omp-plugins/compare/beads--v0.8.0...beads--v0.8.1) (2026-09-08)


### Bug Fixes

* **ci:** reject stale packages and incomplete checker runs ([8274c02](https://github.com/srobroek/omp-plugins/commit/8274c02e6e1af64adb7f6524e7ebabe830d26356))
* correct plugin discovery, safety checks, and workflow contracts ([bfaa850](https://github.com/srobroek/omp-plugins/commit/bfaa850be719d7b79ac2245f2092be838673dd5d))


### Documentation

* clarify plugin safety and usage contracts ([f147fba](https://github.com/srobroek/omp-plugins/commit/f147fbaa08ddae1f5d745defd613b2d33ece4d61))

## [0.8.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.7.0...beads--v0.8.0) (2026-08-27)


### Features

* add design plugin with routed third-party skills and MCP packages ([325fc4c](https://github.com/srobroek/omp-plugins/commit/325fc4c8721b213b5f3c5cc0119cc8be48670165))


### Bug Fixes


## [0.7.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.6.2...beads--v0.7.0) (2026-08-26)


### Features

* **beads:** report a failing check the agent never mentioned ([65635c5](https://github.com/srobroek/omp-plugins/commit/65635c570e6aa70cff5e17ce4015a92b5f51a2b4))
* **beads:** report a failing check the agent never mentioned ([46d3d52](https://github.com/srobroek/omp-plugins/commit/46d3d52ecd2b7bb460ab346f4c2a5a08c5586ef6))

## [0.6.2](https://github.com/srobroek/omp-plugins/compare/beads--v0.6.1...beads--v0.6.2) (2026-08-25)


### Bug Fixes

* **beads:** judge a pre-existing problem by scope, not by difficulty ([47bd49c](https://github.com/srobroek/omp-plugins/commit/47bd49cd79f9d151dde4bac6301c2d3b4bfa6f21))
* **changelog:** drop the entries my merge strategy duplicated ([525b7b1](https://github.com/srobroek/omp-plugins/commit/525b7b11dbe4c6dd85ff6073d916f6b3090bf5ff))

## [0.6.1](https://github.com/srobroek/omp-plugins/compare/beads--v0.6.0...beads--v0.6.1) (2026-08-25)


### Bug Fixes

* **speckit:** retire the spec-id TTSR as a contextual false positive ([f292cca](https://github.com/srobroek/omp-plugins/commit/f292ccac9deb988459859ee1836aaa99deb36317))

## [0.6.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.5.0...beads--v0.6.0) (2026-08-25)


### Features

* **session:** revive session plugin with resume-session skill ([af9251e](https://github.com/srobroek/omp-plugins/commit/af9251e4f4a7b36163d228373b76c21035813eba))

## [0.5.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.4.0...beads--v0.5.0) (2026-08-25)


### Features

* **beads:** own the gate-close guard, and make it watertight ([7663271](https://github.com/srobroek/omp-plugins/commit/7663271c1ff654e47897a96e72e60e2d8db75d47))

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/beads--v0.3.0...beads--v0.4.0) (2026-08-25)


### Features

* **authoring:** lint machine-specific paths and unrepairable frontmatter ([a456af3](https://github.com/srobroek/omp-plugins/commit/a456af3e109c44d1ad1dfbed2078b0a0b8202ccd))
* **beads:** guard the two bd commands that strand or overwrite a run ([3d8e6ec](https://github.com/srobroek/omp-plugins/commit/3d8e6ecbea321aa6007ee2760a5237e93413d731))
* **beads:** make an agent triage the pre-existing problems it runs into ([93cc493](https://github.com/srobroek/omp-plugins/commit/93cc49318936aecea664925d28b42b87a6e227a4))
* **beads:** refresh project memories at session start and after compaction ([477ded9](https://github.com/srobroek/omp-plugins/commit/477ded972309014ebe1e1a3db82b77cce0738259))
* **beads:** session lifecycle extension + four TTSR guards ([9300c07](https://github.com/srobroek/omp-plugins/commit/9300c07a5847262c2870dad5bf368fdc106db5d6))
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
