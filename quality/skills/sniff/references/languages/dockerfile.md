# Dockerfile -- Sniff Reference

Container image build files: `Dockerfile`, `*.dockerfile`, `Containerfile`. A
functional build spec -- the dominant concerns are security (root, secrets, base
provenance), reliability (pinning, cache correctness), and image-size/maintenance.

## Detect

How sniff knows a Dockerfile is present: key files, extensions, config.
- Files/extensions: `Dockerfile`, `Dockerfile.*`, `*.dockerfile`, `Containerfile`
- Related context: `.dockerignore` (its *absence* is a smell), `docker-compose.yml`/`compose.yaml` referencing `build:`
- Config that governs it: `.hadolint.yaml` (rule config / ignores), `.trivyignore`

## Tools

Primary first. Exact invocation + machine-readable flag. Canonical detail in
`../tooling.md`; this is the runnable subset.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| hadolint | **Run recipe.** `hadolint --format json <Dockerfile>` from repo root -- pass each Dockerfile path explicitly (hadolint takes files, not a dir; loop over `Dockerfile`/`*.dockerfile`/`Containerfile`). Auto-reads `.hadolint.yaml` from the repo for rule config + ignores (project config governs). It embeds shellcheck over every `RUN` body, so do not separately shellcheck the Dockerfile. **Exit:** 0 = clean · 1 = findings → parse the JSON array (`file`/`line`/`code`/`level`/`message`; `code` is `DLxxxx` for hadolint, `SCxxxx` for the embedded shellcheck) · a parse/usage error = INVALID, never "clean". | AST rules: pinning, `apt` hygiene, `ADD` vs `COPY`, `USER`, layer order; **embeds shellcheck** for `RUN` lines | default-on | `install-tools.sh --install infra` |
| trivy (config) | **Run recipe (opt-in, security).** `trivy config --format json <dir>` from repo root -- `<dir>` is the dir containing the Dockerfile(s); trivy reads them statically (no build). Reads `.trivyignore` for suppressions. **Exit:** by default 0 even with findings unless `--exit-code 1` is set -- so **do not infer clean from exit 0**; parse the JSON `Results[].Misconfigurations[]` · a scan crash = INVALID. Overlaps hadolint on a few rules (root user, HEALTHCHECK) -- treat hadolint as authoritative for build-time style, trivy for the security gate. | Dockerfile misconfig: root user, missing `HEALTHCHECK`, exposed secrets | opt-in (security) | `install-tools.sh --install security` |
| trivy (image) | **Run recipe (opt-in, security; needs a built image).** `trivy image --format json <image:tag>` from repo root -- `<image:tag>` must already be built/pulled locally. Reads `.trivyignore`. **Exit:** like `trivy config`, default 0 regardless of findings unless `--exit-code 1` -- parse the JSON `Results[]` (`Vulnerabilities[]` for CVEs, `Secrets[]` for baked-in secrets) rather than trusting the exit code · a pull/scan failure = INVALID, not "clean". Run only on a deep pass when an image is available. | built-image scan: OS/library CVEs, embedded secrets in layers | opt-in (security; needs a built image) | `install-tools.sh --install security` |

Notes: `hadolint` is the primary AST linter and already runs `shellcheck` over
every `RUN` body, so do not separately shellcheck a Dockerfile. `trivy config`
reads the Dockerfile statically; `trivy image` needs a built image and surfaces
CVEs/secrets baked into layers -- run it on a deep pass when an image is available.
`trivy config` and hadolint overlap on a few rules (root user, HEALTHCHECK); treat
hadolint as authoritative for build-time style and trivy for the security gate.

## Smell checklist

Beyond what tools flag. Each: what it looks like + the idiomatic alternative.

| Smell | What it looks like (Dockerfile) | Idiomatic alternative |
|-------|---------------------------------|-----------------------|
| Unpinned base image | `FROM node` or `FROM node:latest` | Pin tag + digest: `FROM node:20.11-slim@sha256:…` (DL3006/DL3007) |
| Running as root | No `USER` directive; process runs as uid 0 | Add a non-root `USER appuser` before `CMD`/`ENTRYPOINT` (DL3002) |
| Cache-busting COPY | `COPY . .` *before* installing deps | Copy lockfiles → install deps → then `COPY . .` (order by change frequency) |
| Dirty `apt` install | `RUN apt-get install x` without `--no-install-recommends` / cache cleanup | `apt-get update && apt-get install -y --no-install-recommends x && rm -rf /var/lib/apt/lists/*` (DL3009/DL3015) |
| `ADD` for plain files | `ADD ./app /app` for local files | `COPY` (reserve `ADD` for remote URLs / tar auto-extract) (DL3020) |
| Secrets in layers/ENV | `ENV API_KEY=…`, `ARG` secret, `COPY .env` | Build secrets via `RUN --mount=type=secret`; never bake into a layer |
| No `.dockerignore` | Build context ships `.git`, `node_modules`, secrets | Add `.dockerignore` excluding VCS, deps, env files |
| Fragmented `RUN` | Many `RUN` lines that each create a layer | Combine related commands with `&&` (one cache-coherent layer) |
| Fat single-stage image | Build toolchain + source shipped in final image | Multi-stage build: compile in a builder stage, `COPY --from=builder` artifacts only |
| Missing `HEALTHCHECK` | Long-running service with no health probe | Add `HEALTHCHECK CMD …` (orchestrators/`trivy config` flag absence) |
| Shell-form CMD/ENTRYPOINT | `CMD npm start` (wraps in `/bin/sh -c`, breaks signals) | Exec form: `CMD ["npm","start"]` (DL3025) |

## Idioms & style authorities

- Docker build best practices -- https://docs.docker.com/build/building/best-practices/
- hadolint rules reference -- https://github.com/hadolint/hadolint#rules
- Key conventions: pin base images to a tag **and** digest; run as a non-root
  `USER`; use multi-stage builds to ship only runtime artifacts; order instructions
  by change frequency (rarely-changing deps first) to maximize cache hits; pick a
  minimal base (`-slim`/`-alpine`/`distroless`); never write secrets into ENV/ARG
  or a copied layer.

## refactoring.guru mappings

| Dockerfile smell | refactoring.guru smell | Idiomatic refactoring |
|------------------|------------------------|-----------------------|
| Repeated install/setup across stages or images | Duplicate Code (`/smells/duplicate-code`) | Multi-stage build + a shared base image (`FROM common-base`) |
| Toolchain + artifacts crammed into one image | Large Class (`/smells/large-class`) | Split into builder + runtime stages (multi-stage) |

The OO catalog maps **weakly** here -- most Dockerfile smells are ops-specific
(pinning, layer cache, root, secrets) with no clean refactoring.guru analogue. Cite
the Docker best-practices URL as the authority over forcing an OO mapping.

## Pragmatism notes (for the adversarial pass)

- `:latest` is acceptable in throwaway/dev/CI-scratch images that are rebuilt each
  run and never deployed; reserve the smell for images that ship or get cached.
- `USER root` is legitimate *inside a build stage* that needs to install packages --
  the smell is the *final* stage running as root, not an intermediate one.
- Not every image needs multi-stage: an interpreted-language image with no build
  toolchain (a plain Python script on `-slim`) gains little. Flag fat images, not
  the absence of stages per se.
- `HEALTHCHECK` is meaningful for long-running services, not for one-shot batch/CLI
  images -- don't flag its absence on a job container.
- Security smells (secrets in ENV/layers, root in the final stage, unpinned base
  from an untrusted registry) are rarely false positives -- weight them high.
