#!/usr/bin/env bash
# Audit watchdog discovery for a repository: which files load, in what order, and
# which roster entries conflict. Read-only.
#
# usage: watchdog-audit.sh [repo-dir] [agent-dir]
set -euo pipefail

repo="${1:-$PWD}"
agent_dir="${2:-${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}}"

if [ ! -d "$repo" ]; then
  echo "not a directory: $repo" >&2
  exit 2
fi

repo_root="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || echo "$repo")"

echo "repo:      $repo_root"
echo "agent dir: $agent_dir"
echo

# Discovery order: user level first, then ancestors from the repo root down to cwd.
# Later files sit closer to the end of the advisor prompt and are more prominent.
echo "== discovery order (earliest prompt position first)"
order=()
for f in "$agent_dir/WATCHDOG.md" "$agent_dir/WATCHDOG.yml" "$agent_dir/WATCHDOG.yaml"; do
  [ -f "$f" ] && order+=("user      $f")
done

dirs=()
cur="$repo"
while :; do
  dirs=("$cur" ${dirs[@]+"${dirs[@]}"})
  [ "$cur" = "$repo_root" ] && break
  parent="$(dirname "$cur")"
  [ "$parent" = "$cur" ] && break
  cur="$parent"
done

for d in ${dirs[@]+"${dirs[@]}"}; do
  for f in "$d/WATCHDOG.md" "$d/WATCHDOG.yml" "$d/WATCHDOG.yaml" \
           "$d/.omp/WATCHDOG.md" "$d/.omp/WATCHDOG.yml" "$d/.omp/WATCHDOG.yaml"; do
    [ -f "$f" ] && order+=("project   $f")
  done
done

if [ "${#order[@]}" -eq 0 ] || [ -z "${order[0]:-}" ]; then
  echo "  (none found)"
else
  i=0
  for line in "${order[@]}"; do
    i=$((i + 1))
    path="${line##* }"
    printf '  %d. %-9s %s (%s lines, %s words)\n' "$i" "${line%% *}" "$path" \
      "$(wc -l <"$path" | tr -d ' ')" "$(wc -w <"$path" | tr -d ' ')"
  done
fi

echo
echo "== roster entries"
python3 - "$@" <<'PY' "${order[@]}"
import sys, collections
try:
    import yaml
except ModuleNotFoundError:
    print("  pyyaml unavailable: skipping roster parse")
    sys.exit(0)

paths = [a.split(' ')[-1] for a in sys.argv[1:] if a.endswith(('.yml', '.yaml'))]
seen = collections.OrderedDict()
for path in paths:
    try:
        doc = yaml.safe_load(open(path)) or {}
    except Exception as exc:
        print(f"  MALFORMED {path}: {exc}")
        continue
    if not isinstance(doc, dict):
        print(f"  MALFORMED {path}: document is not a mapping")
        continue
    shared = doc.get('instructions')
    if shared:
        print(f"  shared instructions in {path}: {len(str(shared).split())} words")
    for entry in doc.get('advisors') or []:
        if not isinstance(entry, dict) or not entry.get('name'):
            print(f"  MALFORMED entry in {path}: {entry!r}")
            continue
        slug = str(entry['name']).strip().lower().replace(' ', '-')
        prior = seen.get(slug)
        seen[slug] = {'path': path, 'model': entry.get('model'),
                      'tools': entry.get('tools'),
                      'enabled': entry.get('enabled', True),
                      'words': len(str(entry.get('instructions') or '').split())}
        if prior:
            print(f"  REPLACES  {slug}: {path} overrides {prior['path']}")

print()
for slug, info in seen.items():
    print(f"  {slug:16s} model={info['model'] or '(modelRoles.advisor)':28s} "
          f"tools={info['tools'] or 'default read/grep/glob'} enabled={info['enabled']} "
          f"instructions={info['words']}w  <- {info['path']}")

if len(seen) > 2:
    print(f"\n  WARN {len(seen)} advisors: each is another model loop, token stream, "
          "and immunity window. Justify every entry.")
PY
