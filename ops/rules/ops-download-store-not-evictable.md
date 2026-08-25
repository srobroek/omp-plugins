---
name: ops-download-store-not-evictable
description: Module and package download stores are not evictable build caches; only compiler caches are reclaimed under disk pressure.
condition: ["\\b(?:pnpm\\s+store\\s+prune|go\\s+clean\\s+-modcache|uv\\s+cache\\s+clean|npm\\s+cache\\s+clean)\\b"]
scope: "tool:bash"
interruptMode: never
---
A download store holds bytes fetched from a registry, not bytes this machine
computed. Deleting it does not reclaim regenerable output: it forces every
project on the machine to re-download the same artifacts, and it breaks any
build already resolving against those paths.

Reclaimable under disk pressure: regenerable compiler output -- sccache and the
Go build cache. Evict those to the free-space floor, then stop.

Not reclaimable: the pnpm store, the Go module cache, uv's wheel cache, and the
npm cache. When compiler-cache eviction cannot reach the floor, report the
shortfall instead of pruning a download store.

A deliberate prune the user asked for is their call; say which store and what it
costs to refill before running it.

Floor, roots, and the env knobs: `rule://ops-toolchain-cache-policy`.
