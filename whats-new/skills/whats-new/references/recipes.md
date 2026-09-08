# Programmatic fetch recipes

The point of these recipes: **never read a rendered web page to discover a
version number, a tag list, or a changelog.** Every fact below has a machine
endpoint that returns small, structured output. Run the command, read a few
lines, move on. Reserve web fetching / browsing for genuine prose (a migration
guide, a blog explaining a breaking change) -- not for data you can query.

You decide *which* recipe applies (which ecosystem, which host) and adapt the
commands. They are a cookbook, not a fixed pipeline. All are read-only.

Prereqs, all guardable with `command -v`: `curl`, `jq`, `git`, and optionally
`gh` / `glab` for authenticated host APIs. If one is missing, fall back to the
plain-`curl` variant and say so in the report's Coverage section.

---

## Step A -- resolve the current version (no network)

Call native `version_gap_scan` with `{"path":"<project-root>"}` (omit `path` for
session cwd). It is offline/read-only and returns text rows
`ecosystem<TAB>name<TAB>version` plus `details.deps` objects with `ecosystem`,
`name`, and `version`, and `details.count`. Pick the target's row. A tool error
or nonzero detector exit is a coverage gap, not an empty dependency inventory.

For an exact pinned version, the lockfile beats the manifest range:

```sh
# npm: exact installed version of <pkg>
jq -r '.packages | to_entries[] | select(.key|endswith("node_modules/<pkg>")) | .value.version' package-lock.json | head -1
jq -r '.. | objects | select(.name=="<pkg>") | .version' pnpm-lock.yaml 2>/dev/null   # pnpm v6 lock is YAML; prefer `pnpm why`
# python (uv/poetry export or pip freeze)
grep -i '^<pkg>==' requirements.txt ; pip show <pkg> 2>/dev/null | sed -n 's/^Version: //p'
# cargo
awk '/^name = "<pkg>"/{f=1} f&&/^version/{print;exit}' Cargo.lock
# go
go list -m <module> 2>/dev/null    # prints "<module> vX.Y.Z"
```

If the user already stated the current version, skip this.

---

## Step B -- resolve the latest version + source repo (registry APIs)

One `curl | jq` per ecosystem. Each returns the latest version, the version
list, and the upstream repo URL -- the three things you need to scope the span.
A descriptive `-A` user-agent is **required** by some registries (crates.io
rejects requests without one).

```sh
UA='whats-new-skill (+https://github.com/srobroek/agentic-packages)'

# npm
curl -fsSL -A "$UA" "https://registry.npmjs.org/<name>" \
  | jq -r '{latest: .["dist-tags"].latest, repo: (.repository.url // .repository),
            deprecated: (.versions[.["dist-tags"].latest].deprecated // "no"),
            versions: (.versions|keys)}'

# pypi
curl -fsSL -A "$UA" "https://pypi.org/pypi/<name>/json" \
  | jq -r '{latest: .info.version,
            repo: (.info.project_urls.Source // .info.project_urls.Repository // .info.home_page),
            yanked: .info.yanked, versions: (.releases|keys)}'

# crates.io  (UA is mandatory)
curl -fsSL -A "$UA" "https://crates.io/api/v1/crates/<name>" \
  | jq -r '{latest: .crate.max_stable_version, repo: .crate.repository,
            versions: [.versions[].num]}'

# rubygems
curl -fsSL -A "$UA" "https://rubygems.org/api/v1/gems/<name>.json" \
  | jq -r '{latest: .version, repo: (.source_code_uri // .homepage_uri)}'
curl -fsSL -A "$UA" "https://rubygems.org/api/v1/versions/<name>.json" | jq -r '[.[].number]'

# packagist (php)  — name is vendor/pkg
curl -fsSL -A "$UA" "https://repo.packagist.org/p2/<vendor>/<pkg>.json" \
  | jq -r --arg n "<vendor>/<pkg>" '{latest: .packages[$n][0].version,
       repo: .packages[$n][0].source.url, abandoned: .packages[$n][0].abandoned,
       versions: [.packages[$n][].version]}'
```

### Go modules

The module path *is* the repo for the common hosts. Honor `GOPROXY`:

```sh
# default proxy
curl -fsSL "https://proxy.golang.org/<module>/@latest"            # -> {"Version": "...","Time": "..."}
curl -fsSL "https://proxy.golang.org/<module>/@v/list"            # newline-separated versions

# GOPROXY=direct (or proxy blocked): list tags straight from the repo
git ls-remote --tags --refs "https://<module-host-path>" \
  | sed -E 's#.*refs/tags/##' | sort -V | tail
```

Normalize a repo URL before using it downstream (registries return `git+`,
`ssh://git@`, scp-style `git@host:owner/repo`, trailing `.git`):

```sh
echo "$REPO" | sed -E 's#^git\+##; s#^ssh://git@#https://#; s#^git://#https://#; s#^git@([^:]+):#https://\1/#; s#\.git$##'
```

---

## Step C -- fetch the changes (host-agnostic first, then enrichment)

Order of trust: the project's **migration guide** > **release notes** >
**CHANGELOG** > **commit log**. The first is prose (fetch it as a page); the
last three are queryable. Cover the whole span -- changes accumulate across every
intermediate version, not just the endpoints.

### C1 -- CHANGELOG + commit log from git (works for ANY host)

This is the host-agnostic core: it needs only `git` and the clone URL from Step
B, so it works for GitHub, GitLab, Bitbucket, Codeberg, sr.ht, or a private
remote identically. Bare + blobless clone keeps it cheap.

```sh
REPO_URL=<from step B>
TMP=$(mktemp -d)
git clone --bare --filter=blob:none "$REPO_URL" "$TMP/r.git"
# If the server rejects filtering, retry a bare clone into a fresh temp directory.
G="git --git-dir=$TMP/r.git"
$G tag --list --sort=version:refname
```

Resolve registry versions to **actual full tags** from this inventory: `1.2.3`,
`v1.2.3`, `pkg-v1.2.3`, and `pkg@1.2.3` are distinct names. Select only the
target package's tag family; record the mapping and exact `FROM` / `TO` tags.
Build the release-tag set for **current < version <= target** using the
ecosystem's version comparator (SemVer, PEP 440, etc.), retaining original tags
for API lookup. Git's [version sort](https://git-scm.com/docs/git-tag#Documentation/git-tag.txt---sortltkeygt)
is useful for numeric tag inventory, not a universal prerelease/epoch comparator.
Never compare version strings lexically or use publication dates as version
order. For example, `v1.10.0` follows `v1.9.0`; exclude unrelated package tags.
Use an already-available ecosystem comparator; if none can order nonstandard
tags or the version-to-tag mapping is ambiguous, report the unresolved span
and incomplete coverage rather than guessing. Record prerelease policy.

Keep this temporary repository through all C1 diffs and Step D migration reads.
For a GitHub-hosted file, use native `github` `file_read` with the exact tag as
`branch` and the file's repo-relative `path`; do not fetch file bytes with curl.

```sh
FROM=<resolved-current-full-tag>; TO=<resolved-target-full-tag>
$G rev-parse --verify "refs/tags/$FROM^{commit}"
$G rev-parse --verify "refs/tags/$TO^{commit}"

# Non-GitHub hosts: read the target changelog. GitHub files use file_read above.
for f in CHANGELOG.md CHANGELOG CHANGES.md HISTORY.md NEWS.md docs/CHANGELOG.md; do
  $G cat-file -e "$TO:$f" 2>/dev/null && { echo "== $f =="; $G show "$TO:$f"; break; }
done

# commit log between tags, classified by conventional-commit prefix:
RANGE="$FROM..$TO"
$G log --no-merges --reverse --pretty='%h %s' "$RANGE" | grep -iE '^[0-9a-f]+ [a-z]+(\(.+\))?!:'  # BREAKING (! marker)
$G log --reverse --pretty='%h %s%n%b' "$RANGE" | grep -iE 'BREAKING CHANGE'                        # BREAKING (body)
$G log --no-merges --reverse --pretty='%h %s' "$RANGE" | grep -iE '^[0-9a-f]+ feat(\(.+\))?!?:'    # features
$G log --no-merges --reverse --pretty='%h %s' "$RANGE" | grep -iE '^[0-9a-f]+ fix(\(.+\))?!?:'     # fixes
```

`!` after the type, or a `BREAKING CHANGE:` body trailer, marks a breaking
change -- a *signal*, not ground truth. Read the actual diff for anything
load-bearing: `$G show <sha>` or `$G diff $FROM..$TO -- <path>`.

### C2 -- curated release notes (host API enrichment)

Join release records to the exact selected tag set from C1; filter by tag
membership, never string ranges. Fetch all pages before declaring release-note
coverage complete: publication order can mix backports and prereleases, and a
tag can exist without a release. Exclude drafts; apply the recorded prerelease
policy. Preserve tag, release URL, date, and body/description.

| Host | Reproducible read-only request | Pagination |
|------|------------------------------|------------|
| GitHub | `gh api --paginate "repos/<owner>/<repo>/releases?per_page=100"` | `--paginate` follows all pages; parse every returned array, not only the first. Without gh, GET `https://api.github.com/repos/<owner>/<repo>/releases?per_page=100&page=1` and follow response `Link` headers with `rel="next"`. |
| GitLab | GET `https://gitlab.com/api/v4/projects/<URL-encoded-project>/releases?per_page=100&page=1` | Follow `Link` `rel="next"` or `X-Next-Page` through the final page. |
| Gitea / Codeberg | GET `https://<host>/api/v1/repos/<owner>/<repo>/releases?limit=50&page=1` | Follow `Link` `rel="next"`; server-configured page caps may be below the requested limit. |

Use native/read API access when it exposes headers; otherwise `curl -fsS -i
"<URL>"` exposes status, pagination headers, and JSON. Supply credentials via
the host's supported authorization header only when needed. If pagination
headers are unavailable, increment `page` until a successful empty JSON array;
do not stop merely because one page is shorter than the requested size.
Follow only the same trusted API origin with credentials.

Track pages fetched, expected tags, matched tags, and missing releases. Stop on
HTTP/auth/rate-limit errors, repeated pages, tool-output truncation, or an
unresolved next page and mark coverage **INCOMPLETE**, naming unvisited pages
and unmatched tags. Do not describe an unvisited release as absent. After
complete enumeration, unmatched tags mean no visible release record; use C1's
changelog/commits for those tags and report that distinction.

API contracts: [GitHub releases](https://docs.github.com/en/rest/releases/releases#list-releases)
and [pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api),
[GitLab releases](https://docs.gitlab.com/api/releases/) and
[pagination](https://docs.gitlab.com/api/rest/#pagination),
[Gitea pagination](https://docs.gitea.com/development/api-usage/#pagination).

### C3 -- when there's no changelog and no releases

Some projects ship neither. Then the commit log (C1) is the primary source --
classify it and read the breaking/feat commits' diffs directly. Say so in the
report: "no CHANGELOG or releases; summary derived from the commit log."

---

## Step D -- prose sources (only when needed)

For a major bump, the migration guide is the payload and it's usually prose, not
data. *Now* a targeted web fetch is justified -- fetch the specific
"Upgrading to vN" / "Migration" page, not the docs home. Find its URL from the
repo (`UPGRADING.md`, `MIGRATING.md`, `docs/`) or the release notes' links
rather than searching blind:

```sh
$G ls-tree -r --name-only "$TO" | grep -iE 'migrat|upgrad|breaking'
```

Prefer the project's own guide over third-party blogs; flag blogs as derivative.

After every changelog, commit, diff, and migration consumer has finished, remove
only the temporary directory created in C1 (`rm -rf -- "$TMP"` after checking
its exact path). Never clean it at the end of C1 while Step D still needs `$G`.

---

## Step E -- services, technologies, platforms, model families

Services rarely have semver or a single git repo. "What's new" is a **dated
announcement stream**. The mistake to avoid is asking a model to browse a
vendor's marketing pages -- most vendors publish a machine-readable feed or API.
Pull it, filter to the user's window, group, and cite by date.

Order of preference: vendor change **feed/API** (RSS/Atom/JSON) > vendor
release-notes **repo** (use step C on it) > a single release-notes **page**
(step D, prose). Note many vendor docs release-notes pages are **client-rendered
(JS)** and return placeholder HTML to `curl` -- when that happens, switch to the
feed/API or to web-fetch, don't try to scrape the empty shell.

### AWS -- service announcements (incl. Bedrock, EC2, S3, …)

The "What's New" feed carries every service; filter by keyword in the title.

```sh
UA='whats-new-skill (+https://github.com/srobroek/agentic-packages)'
# All recent announcements (RSS). Filter to a service, e.g. Bedrock:
curl -fsSL -A "$UA" "https://aws.amazon.com/about-aws/whats-new/recent/feed/" \
  | tr '>' '>\n' \
  | grep -iE '<title>|<pubDate>' | grep -iE 'bedrock|<pubDate>'
# Structured (needs xmllint or a quick python parse) — title + date + link:
curl -fsSL -A "$UA" "https://aws.amazon.com/about-aws/whats-new/recent/feed/" \
  | python3 -c 'import sys,xml.etree.ElementTree as ET; \
r=ET.fromstring(sys.stdin.read()); \
[print(i.findtext("pubDate"),"|",i.findtext("title")) for i in r.iter("item") \
 if "bedrock" in (i.findtext("title") or "").lower()]'
```

AWS service docs also have a per-service "document history" RSS (linked from each
service's docs). For the SDKs, treat them as versioned software (step B/C): e.g.
`aws/aws-sdk-js-v3`, `boto3`, `aws-sdk-go-v2` on GitHub.

### Anthropic / Claude

Prefer the repo's **`claude-api`** skill for model IDs, pricing, and migration --
it's the curated source. For the live model list:

```sh
# Models the API currently serves (needs a key). 401 without one confirms shape.
curl -fsSL https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  | jq -r '.data[] | "\(.created_at)  \(.id)  \(.display_name)"' | sort
```

The docs release-notes page (`docs.anthropic.com/en/release-notes/api`) is
JS-rendered -- fetch it with a browser/web-fetch capability, not `curl`, or rely
on the models API + `claude-api` skill.

### OpenAI

```sh
# Models served (needs key):
curl -fsSL https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" \
  | jq -r '.data[] | "\(.created)  \(.id)"' | sort
# Changelog/release notes pages are prose — step D.
```

### Google Cloud -- per-service release-notes feeds

GCP publishes a release-notes XML feed per service:

```sh
# e.g. BigQuery; swap the slug for other services (compute, run, etc.):
curl -fsSL "https://cloud.google.com/feeds/bigquery-release-notes.xml" \
  | python3 -c 'import sys,xml.etree.ElementTree as ET; \
r=ET.fromstring(sys.stdin.read()); ns={"a":"http://www.w3.org/2005/Atom"}; \
[print(e.findtext("a:updated",namespaces=ns),"|",e.findtext("a:title",namespaces=ns)) \
 for e in r.findall(".//a:entry",ns)][:40]'
```

### Microsoft Azure -- updates feed

```sh
curl -fsSL "https://www.microsoft.com/releasecommunications/api/v2/azure/rss" \
  | python3 -c 'import sys,xml.etree.ElementTree as ET; \
r=ET.fromstring(sys.stdin.read()); \
[print(i.findtext("pubDate"),"|",i.findtext("title")) for i in r.iter("item")][:40]'
```

### Other services

Most SaaS/platforms expose one of: an RSS/Atom feed (look for
`/changelog.rss`, `/feed`, `/releases.atom`), a changelog repo on GitHub (step
C), or a developer-changelog API. GitHub Actions runner images, Stripe, Datadog,
etc. follow this. Find the feed once (`curl -fsI <guess>` to confirm a feed
content-type) and cache the URL in the report's Sources.

---

## Coverage discipline

Always end knowing -- and reporting -- which of these ran and which didn't.
*Software:* current version (lockfile vs. range vs. user-supplied), latest
(registry), release notes (present per-tag? or only some?), CHANGELOG (found? at
which tag?), commit log (tags resolved?), migration guide (exists?).
*Service:* which feed/API was used, the exact window covered, and whether
"announced" vs. "GA in your region/account" was distinguished. A clean-looking
summary built from one source out of five is not the same as researched change.
