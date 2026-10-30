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
  local steps gates provisional workers
  steps=$(grep -c '^\[\[steps\]\]$' "$file")
  gates=$(grep -c '^type = "human"$' "$file" || true)
  provisional=$(grep -c '^labels = .*"provisional"' "$file" || true)
  workers=$(grep -c '^execution_mode = "subagent"$' "$file" || true)
  printf '%s: %s steps, %s gates, %s provisional gates, %s worker steps\n' "$formula" "$steps" "$gates" "$provisional" "$workers"
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

# The joint sweep is L4's full check: it bonds onto the full-check step, every other case onto the fan-out step.
bond mol-cad-analysis "$(step "$product_root" full-check phase:analysis)" "${product[@]}" --var case=sweep --var kind=sweep --var version=v4 --ref analysis-sweep-v4
bond mol-cad-analysis "$(step "$product_root" fanout phase:analysis)" "${product[@]}" --var case=pins-stack --var kind=stackup --var version=v4 --ref analysis-pins-stack

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
bond mol-cad-analysis "$(step "$eco_root" full-check phase:analysis)" "${eco[@]}" --var case=sweep --var kind=sweep --var version=v2 --ref analysis-sweep-v2
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

# Dry walk of one stage's two gates on a fresh cad-product root. L1 LAYOUT: the provisional gate opens the
# full check and L2 PARTS, a VOID reopen blocks both again, and the human gate opens only after the full check.
# A change named at the human gate after the full check passed, with L2 already integrated on that version,
# reopens the full check and the L2 steps too.
walk_root=$(pour cad-product --var product=smoke-walk --var scope=hw/ --var kernel=cadquery --var process_default=fdm)
bd list --parent "$walk_root" --all --json >"$work/walk.json"
# The id of the one walk step whose title starts with $1.
walk_step() {
  python3 - "$work/walk.json" "$1" <<'PY'
import json, sys
found = [i["id"] for i in json.load(open(sys.argv[1])) if i["title"].startswith(sys.argv[2])]
if len(found) != 1:
    sys.exit(f"FAIL: {len(found)} walk steps titled {sys.argv[2]!r}")
print(found[0])
PY
}
walk_pass() { bd close "$(walk_step "$1")" --reason "$2" >/dev/null; }
walk_approve() {
  local id=$1
  bd show "$id" --json >"$work/gated.json"
  gate=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d=d[0] if isinstance(d,list) else d; print(next(x["id"] for x in d["dependencies"] if x["title"].startswith("Gate:")))' "$work/gated.json")
  bd gate resolve "$gate" --reason 'smoke: user approved' >/dev/null
}
# $1 names the moment; each further argument is +TITLE (must be ready) or -TITLE (must not be), as a title prefix.
walk_ready() {
  local moment=$1
  shift
  bd ready --json --limit 0 >"$work/ready.json"
  python3 - "$work/ready.json" "$work/walk.json" "$moment" "$@" <<'PY'
import json, sys
ready_path, walk_path, moment, *wants = sys.argv[1:]
walk = {i["id"] for i in json.load(open(walk_path))}
titles = sorted(i["title"] for i in json.load(open(ready_path)) if i["id"] in walk)
for want in wants:
    sign, title = want[0], want[1:]
    if (sign == "+") != any(t.startswith(title) for t in titles):
        sys.exit(f"FAIL: walk {moment}: {title!r} is {'not ' if sign == '+' else ''}ready; ready: {titles}")
print(f"walk {moment}: ready {titles}")
PY
}
# The VOID a stage's full-check step gives: it runs exactly the step's own `bd reopen` command, resolving
# `<later closed steps>` with the `bd dep tree` query the step names. Written to a file because bash misparses
# backticks in a heredoc inside `$(...)`.
cat >"$work/void_ids.py" <<'PY'
import json, re, subprocess, sys, tomllib
formula, full, walk_path, root = sys.argv[1:]
with open(formula, "rb") as handle:
    steps = {step["id"]: step for step in tomllib.load(handle)["steps"]}
walk = json.load(open(walk_path))
def issue(step_id):
    title = steps[step_id]["title"].replace("{{product}}", "smoke-walk")
    found = [i["id"] for i in walk if i["title"] == title]
    if len(found) != 1:
        sys.exit(f"FAIL: {full} reopens {step_id!r}, which matches {len(found)} walk steps")
    return found[0]
def bd(*args):
    return json.loads(subprocess.run(["bd", *args], check=True, capture_output=True, text=True).stdout)
text = steps[full]["description"]
(arguments,) = re.findall(r"`bd reopen ([^`]*) --reason [^`]*`", text)
ids = []
for placeholder in re.findall(r"<([^>]+)>", arguments):
    if placeholder != "later closed steps":
        ids.append(issue(placeholder.removesuffix("-step")))
        continue
    ((tree_root, label),) = re.findall(
        r"where `<later closed steps>` are the ids `bd dep tree <([a-z0-9-]+)-step> --direction=up --status=closed --json` "
        r"lists, except steps labelled `([^`]+)` and bonded molecules", text)
    labelled = {i["id"] for i in bd("list", "--parent", root, "--label", label, "--all", "--json")}
    tree = bd("dep", "tree", issue(tree_root), "--direction=up", "--status=closed", "--json")
    ids += [i["id"] for i in tree if i["id"] not in labelled and "." not in i["id"]]
print(" ".join(dict.fromkeys(ids)))
PY
# $1 is the VOID reason, $2 the formula id of the stage's full-check step.
walk_void() {
  local reason=$1 full=$2 ids
  ids=$(python3 "$work/void_ids.py" "$work/.beads/formulas/cad-product.formula.toml" "$full" "$work/walk.json" "$walk_root")
  # shellcheck disable=SC2086 # $ids is a space-separated list of bead ids
  bd reopen $ids --reason "$reason" >/dev/null
}
walk_pass GROUND 'smoke: grounded'
walk_approve "$(walk_step 'INTENT gate')"
walk_pass 'INTENT gate' 'smoke: user approved'
walk_pass SPECIFY 'smoke: specified'
walk_pass 'L0 CONCEPT: fan out' 'smoke: no variants'
walk_pass 'L0 CONCEPT: merge' 'smoke: merged'
walk_approve "$(walk_step 'VARIANT gate')"
walk_pass 'VARIANT gate' 'smoke: user selected'
walk_ready 'v1 fast checks running' '+L1 LAYOUT' '-LAYOUT provisional gate' '-L2 PARTS: fan out'
walk_pass 'L1 LAYOUT' 'smoke: v1 built, fast checks 1-4 passed'
walk_ready 'v1 fast checks passed' '+LAYOUT provisional gate' '-LAYOUT full check' '-L2 PARTS: fan out' '-LAYOUT freeze gate'
walk_pass 'LAYOUT provisional gate' 'PROVISIONAL, temporary until layout-full-check: v1 passed fast checks 1-4'
walk_ready 'v1 provisional' '+LAYOUT full check' '+L2 PARTS: fan out' '-LAYOUT freeze gate'
walk_void 'VOID: v1 full sweep failed' layout-full-check
walk_ready 'v1 full check failed (VOID)' '+L1 LAYOUT' '-LAYOUT provisional gate' '-LAYOUT full check' '-L2 PARTS: fan out'
walk_pass 'L1 LAYOUT' 'smoke: v2 built, fast checks 1-4 passed'
walk_pass 'LAYOUT provisional gate' 'PROVISIONAL, temporary until layout-full-check: v2 passed fast checks 1-4'
walk_ready 'v2 provisional' '+LAYOUT full check' '+L2 PARTS: fan out' '-LAYOUT freeze gate'
walk_pass 'LAYOUT full check' 'smoke: v2 full check passed'
walk_ready 'v2 full check passed, human gate open' '-LAYOUT freeze gate' '+L2 PARTS: fan out'
walk_pass 'L2 PARTS: fan out' 'smoke: no units'
walk_pass 'L2 PARTS: integrate' 'smoke: v3 built on the v2 layout, fast checks 1-4 passed'
walk_pass 'PARTS provisional gate' 'PROVISIONAL, temporary until parts-full-check: v3 passed fast checks 1-4'
walk_ready 'v3 parts provisional' '+PARTS full check' '+L3 DETAIL: fan out' '-LAYOUT freeze gate'
walk_void 'VOID: the user named a layout change at the LAYOUT freeze gate' layout-full-check
walk_ready 'layout change named at the human gate (VOID)' '+L1 LAYOUT' '-LAYOUT full check' '-LAYOUT freeze gate' \
  '-L2 PARTS: integrate' '-PARTS provisional gate' '-PARTS full check' '-L3 DETAIL: fan out'
walk_pass 'L1 LAYOUT' 'smoke: v4 built, fast checks 1-4 passed'
walk_pass 'LAYOUT provisional gate' 'PROVISIONAL, temporary until layout-full-check: v4 passed fast checks 1-4'
walk_ready 'v4 provisional' '+LAYOUT full check' '+L2 PARTS: integrate' '-LAYOUT freeze gate' '-PARTS provisional gate'
walk_pass 'LAYOUT full check' 'smoke: v4 full check passed'
walk_ready 'v4 full check passed, human gate open' '-LAYOUT freeze gate'
walk_approve "$(walk_step 'LAYOUT freeze gate')"
walk_ready 'user approved the freeze' '+LAYOUT freeze gate'

echo "PASS: poured cad-part, cad-product, cad-touch; bonded all eight mol-cad formulas onto their fan-out and full-check steps; walked the LAYOUT provisional, full-check and human gates in $BEADS_DIR"
