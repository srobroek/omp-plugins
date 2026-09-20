#!/usr/bin/env bash
# Probe a project's watchdog files live: run one headless advised session in a scratch
# copy and report per-review latency, note volume, and artifact-citation rate.
#
# usage: watchdog-probe.sh <repo-dir> "<scenario prompt>" [model-selector]
#
# The scratch workspace copies the project's .omp watchdog files only, so the probe
# measures the prompt, not the repository contents. Nothing in <repo-dir> is modified.
set -euo pipefail

repo="${1:?repo dir required}"
prompt="${2:?scenario prompt required}"
model="${3:-}"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/watchdog-probe.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/.omp"

copied=0
for name in WATCHDOG.md WATCHDOG.yml WATCHDOG.yaml; do
  for src in "$repo/.omp/$name" "$repo/$name"; do
    if [ -f "$src" ]; then
      cp "$src" "$scratch/.omp/$name"
      copied=$((copied + 1))
      break
    fi
  done
done
echo "copied $copied project watchdog file(s) into the scratch workspace"

if [ -n "$model" ] && [ -f "$scratch/.omp/WATCHDOG.yml" ]; then
  python3 - "$scratch/.omp/WATCHDOG.yml" "$model" <<'PY'
import re, sys
path, model = sys.argv[1], sys.argv[2]
text = open(path).read()
if re.search(r'(?m)^\s*model:', text):
    text = re.sub(r'(?m)^(\s*)model:.*$', lambda m: f'{m.group(1)}model: "{model}"', text, count=1)
else:
    text = re.sub(r'(?m)^(\s*- name:.*)$', lambda m: f'{m.group(1)}\n    model: "{model}"', text, count=1)
open(path, 'w').write(text)
print(f"pinned advisor model to {model}")
PY
fi

# Seed a tiny, deterministic workspace so the primary agent has something to do.
mkdir -p "$scratch/src"
printf 'def parse_row(line):\n    return [f.strip() for f in line.split(",") if f.strip()]\n' \
  >"$scratch/src/parser.py"
printf 'def summarize(rows):\n    return {"rows": len(rows)}\n' >"$scratch/src/report.py"

start=$(date +%s)
( cd "$scratch" && omp -p "$prompt" --advisor >"$scratch/stdout.txt" 2>"$scratch/stderr.txt" ) || true
wall=$(( $(date +%s) - start ))
echo "session wall time: ${wall}s"

python3 - "$scratch" <<'PY'
import json, os, re, sys

scratch = sys.argv[1]
slug = '-' + scratch.strip('/').replace('/', '-')
root = os.path.expanduser('~/.omp/agent/sessions')
cand = [d for d in os.listdir(root) if d.endswith(slug.split('-')[-1])] if os.path.isdir(root) else []
sess_dir = None
for d in sorted(cand, reverse=True):
    p = os.path.join(root, d)
    if os.path.isdir(p):
        sess_dir = p
        break
if not sess_dir:
    print('no session directory found for the probe workspace')
    sys.exit(0)

stems = sorted(f for f in os.listdir(sess_dir) if f.endswith('.jsonl'))
if not stems:
    print('probe session produced no transcript')
    sys.exit(0)
primary = os.path.join(sess_dir, stems[-1])
adv_dir = primary[:-len('.jsonl')]
advisor = None
if os.path.isdir(adv_dir):
    for f in os.listdir(adv_dir):
        if f.startswith('__advisor') and f.endswith('.jsonl'):
            advisor = os.path.join(adv_dir, f)
            break

def rows(path):
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except Exception:
                    continue

updates = calls = 0
dur = []
if advisor:
    for r in rows(advisor):
        if r.get('type') != 'message':
            continue
        m = r.get('message') or {}
        if m.get('role') == 'user' and m.get('synthetic'):
            updates += 1
        elif m.get('role') == 'assistant':
            calls += 1
            if m.get('duration'):
                dur.append(m['duration'] / 1000.0)

notes = []
for r in rows(primary):
    blob = json.dumps(r)
    for body in re.findall(r'<advisory[^>]*>(.*?)</advisory>', blob, re.S):
        notes.append(body)

cited = sum(1 for n in notes if re.search(r'EVIDENCE:|:\d+|\$ |`', n))
per_review = (sum(dur) / updates) if updates else 0.0
print(f'reviews={updates} model calls={calls} ({calls / max(1, updates):.1f} per review)')
print(f'advisor model time={sum(dur):.1f}s  per review={per_review:.1f}s')
print(f'notes delivered={len(notes)}  citing an artifact={cited}')
for n in notes[:5]:
    print('  -', ' '.join(n.split())[:200])
PY
