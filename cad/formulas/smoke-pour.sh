#!/usr/bin/env bash
# Prove every CAD formula pours or bonds in an isolated Beads workspace, that each worker step
# routes to a shipped agent, and that one fan-out step makes all of its bonded units ready at once.
# Requires bd and python3 on PATH; the repo's .beads store is never used.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

mkdir -p "$work/.beads/formulas"
cp "$repo"/cad/formulas/*.formula.toml "$work/.beads/formulas/"
cd "$work"
export BEADS_DIR="$work/.beads"
export BEADS_ACTOR=cad-formula-smoke
export BEADS_DOLT_SHARED_SERVER=

bd init --quiet >/dev/null

fail() { echo "FAIL: $*" >&2; exit 1; }

# Static routing: every worker step names an agent the plugin ships, and every step of a
# worker molecule runs as a subagent.
for agent in $(sed -n 's/^execution_agent_type = "\(.*\)"$/\1/p' "$repo"/cad/formulas/*.formula.toml | sort -u); do
  [[ -f "$repo/cad/agents/$agent.md" ]] || fail "execution_agent_type $agent has no cad/agents/$agent.md"
  echo "agent $agent: cad/agents/$agent.md"
done
for formula in mol-cad-variant mol-cad-part mol-cad-sourcing mol-cad-detail mol-cad-analysis; do
  file="$repo/cad/formulas/$formula.formula.toml"
  [[ $(grep -c '^\[\[steps\]\]$' "$file") == $(grep -c '^execution_mode = "subagent"$' "$file") ]] \
    || fail "$formula has a step that does not run as a subagent"
done

formula_counts() {
  local formula=$1 file="$work/.beads/formulas/$1.formula.toml"
  local steps gates workers
  steps=$(grep -c '^\[\[steps\]\]$' "$file")
  gates=$(grep -c '^type = "human"$' "$file" || true)
  workers=$(grep -c '^execution_mode = "subagent"$' "$file" || true)
  printf '%s: %s steps, %s gates, %s worker steps\n' "$formula" "$steps" "$gates" "$workers"
}

pour() {
  local formula=$1 output root
  shift
  output=$(bd mol pour "$formula" "$@")
  printf '%s\n' "$output" >&2
  root=$(sed -n 's/.*Root issue: //p' <<<"$output")
  [[ -n "$root" ]] || fail "$formula pour printed no 'Root issue:' line"
  formula_counts "$formula" >&2
  printf '%s' "$root"
}

# The id of the one child of $1 carrying every label in $2..; fan-out steps carry `fanout`.
step() {
  local parent=$1
  shift
  local labels=()
  for label in "$@"; do labels+=(--label "$label"); done
  bd list --parent "$parent" "${labels[@]}" --json >"$work/step.json"
  python3 - "$work/step.json" "$parent" "$*" <<'PY'
import json, sys
found = json.load(open(sys.argv[1]))
if len(found) != 1:
    sys.exit(f"FAIL: {len(found)} children of {sys.argv[2]} carry labels {sys.argv[3]}")
print(found[0]["id"])
PY
}

bond() {
  local formula=$1 target=$2 output
  shift 2
  output=$(bd mol bond "$formula" "$target" --type parallel "$@")
  printf '%s\n' "$output"
  grep -Fq "Bonded: $formula + $target" <<<"$output" || fail "$formula did not bond onto $target"
}

part_root=$(pour cad-part --var product=smoke-part --var scope=hw/ \
  --var kernel=cadquery --var process_default=fdm)
product_root=$(pour cad-product --var product=smoke-product --var scope=hw/ \
  --var kernel=build123d --var process_default=cnc)
eco_root=$(pour cad-touch --var product=smoke-part --var scope=hw/ \
  --var part=SMK-0001 --var from_rev=A --var to_rev=B --var release_rev=C \
  --var decision=DR-001 --var change='smoke ECO' \
  --var kernel=cadquery --var process_default=fdm)

product=(--var product=smoke-product --var scope=hw/)
build=(--var kernel=build123d --var process_default=cnc)

concept=$(step "$product_root" fanout phase:concept)
bond mol-cad-variant "$concept" "${product[@]}" --var variant=short-reach --var tradeoff='short reach, stiff' --ref variant-short-reach
bond mol-cad-variant "$concept" "${product[@]}" --var variant=long-reach --var tradeoff='long reach, light' --ref variant-long-reach

parts=$(step "$product_root" fanout phase:parts)
bond mol-cad-part "$parts" "${product[@]}" "${build[@]}" --var subassembly=frame --var change='model the frame' --ref part-frame
bond mol-cad-part "$parts" "${product[@]}" "${build[@]}" --var subassembly=arm_sub --var change='model the arm' --ref part-arm_sub
bond mol-cad-sourcing "$parts" "${product[@]}" --var family=pins --var parts=SMK-0005,SMK-0006 --ref source-pins

detail=$(step "$product_root" fanout phase:detail)
bond mol-cad-detail "$detail" "${product[@]}" "${build[@]}" --var part=SMK-0001 --var change='L3 detail' --ref detail-SMK-0001
bond mol-cad-detail "$detail" "${product[@]}" "${build[@]}" --var part=SMK-0002 --var change='L3 detail' --ref detail-SMK-0002

analysis=$(step "$product_root" fanout phase:analysis)
bond mol-cad-analysis "$analysis" "${product[@]}" --var case=sweep --var kind=sweep --var version=v4 --ref analysis-sweep
bond mol-cad-analysis "$analysis" "${product[@]}" --var case=pins-stack --var kind=stackup --var version=v4 --ref analysis-pins-stack

variant_gate=$(bd list --parent "$product_root" --label phase:gate --title 'VARIANT gate' --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
bond mol-cad-concept "$variant_gate" "${product[@]}" "${build[@]}" --var round=2 --ref concept-round-2
bond mol-cad-variant "$(step "$variant_gate.concept-round-2" fanout)" "${product[@]}" \
  --var variant=folding --var tradeoff='folds flat' --ref variant-folding

bond mol-cad-iterate "$product_root" "${product[@]}" "${build[@]}" \
  --var change='approved intent change' --var affected_parts=SMK-0001 --ref iterate-affected
bond mol-cad-detail "$(step "$product_root.iterate-affected" fanout phase:iterate)" "${product[@]}" "${build[@]}" \
  --var part=SMK-0001 --var change='approved intent change' --ref detail-SMK-0001
bond mol-cad-analysis "$(step "$product_root.iterate-affected" fanout phase:analysis)" "${product[@]}" \
  --var case=fea-head --var kind=fea --var version=v9 --ref analysis-fea-head
bond mol-cad-release "$product_root" "${product[@]}" "${build[@]}" --var release_rev=A --ref release-A

bond mol-cad-part "$(step "$part_root" fanout phase:parts)" --var product=smoke-part --var scope=hw/ \
  --var subassembly=SMK-0001 --var change='model the part' \
  --var kernel=cadquery --var process_default=fdm --ref part-SMK-0001

eco=(--var product=smoke-part --var scope=hw/ --var kernel=cadquery --var process_default=fdm)
revise=$(step "$eco_root" fanout phase:eco)
bond mol-cad-detail "$revise" "${eco[@]}" --var part=SMK-0001 --var change='ECO DR-001; set rev B' --ref detail-SMK-0001
bond mol-cad-detail "$revise" "${eco[@]}" --var part=SMK-0002 --var change='ECO DR-001 dependent; set rev B' --ref detail-SMK-0002
bond mol-cad-analysis "$(step "$eco_root" fanout phase:analysis)" "${eco[@]}" --var case=sweep --var kind=sweep --var version=v2 --ref analysis-sweep
# Also exercise an ECO-specific target rather than relying on another pour root.
bond mol-cad-release "$eco_root" "${eco[@]}" --var release_rev=B --ref release-B

for formula in mol-cad-variant mol-cad-part mol-cad-sourcing mol-cad-detail mol-cad-analysis \
  mol-cad-concept mol-cad-iterate mol-cad-release; do
  formula_counts "$formula"
done

# One batch: once the ECO intent gate is approved, both bonded revision units are ready together
# and the integration step waits until every one of them closes.
bd close "$(bd list --parent "$eco_root" --label phase:eco --title 'Record ECO' --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')" --reason smoke >/dev/null
intent=$(bd list --parent "$eco_root" --label phase:gate --title 'INTENT gate' --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
bd show "$intent" --json >"$work/intent.json"
gate=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d=d[0] if isinstance(d,list) else d; print(next(x["id"] for x in d["dependencies"] if x["title"].startswith("Gate:")))' "$work/intent.json")
bd gate resolve "$gate" --reason 'smoke: approved' >/dev/null
bd close "$intent" --reason smoke >/dev/null
bd ready --json --limit 0 >"$work/ready.json"
python3 - "$work/ready.json" "$revise" <<'PY'
import json, sys
fanout = sys.argv[2]
ready = [i for i in json.load(open(sys.argv[1])) if i["id"].startswith(fanout + ".")]
batch = sorted(i["id"] for i in ready if (i.get("metadata") or {}).get("execution_mode") == "subagent")
want = [f"{fanout}.detail-SMK-0001.detail", f"{fanout}.detail-SMK-0002.detail"]
if batch != want:
    sys.exit(f"FAIL: ready worker batch under {fanout} is {batch}, want {want}")
agents = {(i.get("metadata") or {}).get("execution_agent_type") for i in ready}
print(f"ready batch under {fanout}: {len(batch)} worker steps for {sorted(agents)}")
PY
bd ready --json --limit 0 | python3 -c 'import json,sys; sys.exit("FAIL: revise-integrate ready before its units closed" if any(i["title"].startswith("Integrate the revised parts") for i in json.load(sys.stdin)) else 0)'

echo "PASS: poured cad-part, cad-product, cad-touch; bonded all eight mol-cad formulas onto their fan-out steps in $BEADS_DIR"
