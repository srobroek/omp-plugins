#!/usr/bin/env python3
"""Lint agentic assets (skills, steering, agents) against the write-agentic
format contract. stdlib only.

Usage: lint.py <file> [<file>...]
Exit: 0 clean, 1 any ERROR (WARNs alone stay 0).

Kind detection: SKILL.md -> skill · *.agent.md / agents/*.md -> agent ·
*.instructions.md -> pointer · *.context.md -> context.

Per-file overrides (frontmatter):
  x-lint:
    allow: [E1]
    reason: "trigger-rich description needed for reliable skill routing"

Rules: `allow` suppresses those codes for that file ONLY; `reason` is REQUIRED
(missing reason = E9 error); suppressed findings still print as
  OVERRIDDEN E1 (reason: ...)
W-codes may also be allowed.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Hedges that make a rule subjective. Only flagged on normative lines (keyword
# lines), not in prose sections like OUTPUT examples.
HEDGES = re.compile(
    r"\b(when (practical|appropriate|possible|needed|available)|consider|"
    r"generally|usually|normally|if necessary|as needed|try to|ideally|"
    r"where possible|genuinely|materially|substantial(ly)?|reasonabl[ye]|"
    r"clearly|obvious(ly)?|large enough|significant(ly)?)\b",
    re.I,
)
MODEL_NAMES = re.compile(r"\b(opus|sonnet|haiku|fable|gpt-\d)\b", re.I)
# Keyword-style normative lines (RFC-2119 convention)
KEYWORD_LINE = re.compile(r"^\s*(MUST|DEFAULT|ASK|NOT)\s+\S", re.M)
# Old sigil lines — still accepted but not required
SIGIL_LINE = re.compile(r"^\s*[!~?−-]\s+\S")
CAPS_ENUM = re.compile(r"\b[A-Z][A-Z-]{2,}(\|[A-Z][A-Z-]{2,})+\b")
FRONTMATTER_KEY = re.compile(r"^(\w[\w-]*):", re.M)

# Anti-pattern rules ported from plugin-eval (wshobson/agents static.py).
# W10 OVER_CONSTRAINED: skills with more than this many MUST/NEVER/ALWAYS directives
# become brittle and reduce model flexibility. Threshold matches plugin-eval.
_OVER_CONSTRAINED_THRESHOLD = 15
# W11 MISSING_TRIGGER: recognised trigger phrasings a model uses to decide when to
# invoke a skill. Extended beyond plugin-eval's set to include "Use for/to" and
# "invoke" which are common in this corpus alongside "Use when/after/before".
_TRIGGER_PATTERN = re.compile(
    r"\b(?:should\s+be\s+)?used?\s+(?:this\s+skill\s+)?(?:immediately\s+)?"
    r"(?:when|after|before|whenever|for|to)\b"
    r"|\buse\s+proactively\b"
    r"|\btrigger(?:s)?\s+(?:when|on)\b"
    r"|\bauto[-\s]?loads?\s+(?:when|on)\b"
    r"|\binvoke\b",
    re.IGNORECASE,
)
# W12 BLOATED_SKILL: line threshold above which a skill without a references/ dir
# is considered to need progressive disclosure. Threshold matches plugin-eval.
_BLOATED_LINE_THRESHOLD = 800
# YAML folded/literal scalar markers that prefix multi-line frontmatter values.
# Strip before checking character length so ">-" doesn't look like a short desc.
_YAML_SCALAR_PREFIX = re.compile(r"^[>|][>|-]?\s*")


def words(s: str) -> int:
    return len(s.split())


def _blank_code_spans(text: str) -> str:
    """Replace fenced blocks and inline code with spaces, preserving offsets.

    Content inside code is being shown, not asserted, so checks that judge intent
    must not read it. Offsets are preserved so reported positions stay accurate.
    """
    out = list(text)

    def blank(start: int, end: int) -> None:
        for i in range(start, min(end, len(out))):
            if out[i] != "\n":
                out[i] = " "

    for m in re.finditer(r"^[ \t]*(```+|~~~+)[^\n]*\n.*?^[ \t]*\1[^\n]*$", text, re.S | re.M):
        blank(*m.span())
    for m in re.finditer(r"(`+)(?:(?!\1).)*?\1", "".join(out), re.S):
        blank(*m.span())
    return "".join(out)


def detect_kind(path: Path) -> str:
    n = path.name
    if n.startswith("template-"):
        return "template"  # meta-documents with placeholders: skip
    if n == "SKILL.md":
        return "skill"
    if n.endswith(".agent.md") or path.parent.name == "agents":
        return "agent"
    if n.endswith(".instructions.md"):
        return "pointer"
    if n.endswith(".context.md"):
        return "context"
    return "unknown"


def split_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    fm: dict[str, str] = {}
    key = None
    for line in parts[1].splitlines():
        m = re.match(r"^(\w[\w-]*):\s*(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            fm[key] = val
        elif key and line.startswith(" "):
            fm[key] += " " + line.strip()
    return fm, parts[2]


def parse_xlint(text: str) -> tuple[set[str], str]:
    """Parse x-lint block from raw frontmatter text.

    Returns (allowed_codes, reason).  Missing or malformed block returns empty
    set and empty string.  The `allow` key is parsed as a YAML inline list or
    multi-line block list; `reason` is a scalar string.
    """
    if not text.startswith("---"):
        return set(), ""
    parts = text.split("---", 2)
    if len(parts) < 3:
        return set(), ""
    fm_text = parts[1]

    # Locate the x-lint: block (indented child lines follow)
    xlint_m = re.search(r"^x-lint:\s*$", fm_text, re.M)
    if not xlint_m:
        return set(), ""

    # Grab lines belonging to x-lint (indented, non-empty)
    after = fm_text[xlint_m.end():]
    block_lines: list[str] = []
    for line in after.splitlines():
        if line == "" or line[0] == " " or line[0] == "\t":
            block_lines.append(line)
        else:
            break  # back to top-level key
    block = "\n".join(block_lines)

    # Parse `allow` — inline list [E1, E2] or block list entries
    codes: set[str] = set()
    inline = re.search(r"allow:\s*\[([^\]]*)\]", block)
    if inline:
        for tok in inline.group(1).split(","):
            tok = tok.strip().strip("'\"")
            if tok:
                codes.add(tok)
    else:
        # Block list: lines like "  - E1"
        after_allow = re.search(r"allow:\s*\n((?:\s+-\s+\S+\n?)*)", block)
        if after_allow:
            for tok in re.findall(r"-\s+(\S+)", after_allow.group(1)):
                codes.add(tok.strip("'\""))

    # Parse `reason`
    reason_m = re.search(r"reason:\s*[\"']?(.+?)[\"']?\s*$", block, re.M)
    reason = reason_m.group(1).strip().strip('"\'') if reason_m else ""

    return codes, reason


def _has_rules_contract(path: Path, fm: dict) -> bool:
    """True if this agent has a companion rules file that declares a
    completion contract, i.e. .apm/rules/<name>.rules.json with a non-empty
    `completion` list. The agent file lives at .apm/agents/<name>.agent.md, so
    the rules dir is a sibling: ../rules/. Name comes from frontmatter, falling
    back to the filename stem. Any read/parse error → False (no contract)."""
    name = (fm.get("name") or "").strip() or path.name.split(".")[0]
    rules_dir = path.parent.parent / "rules"
    # Effort-tier variants (coder-low/-medium/-high/-xhigh) share the base's
    # rules file (same contract, different effort). Try the exact name, then
    # the name with a trailing -<tier> suffix stripped.
    candidates = [name]
    m = re.match(r"^(.*)-(low|medium|high|xhigh)$", name)
    if m:
        candidates.append(m.group(1))
    data = None
    for cand in candidates:
        try:
            import json as _json
            data = _json.loads((rules_dir / f"{cand}.rules.json").read_text(encoding="utf-8"))
            break
        except Exception:
            continue
    if data is None:
        return False
    completion = data.get("completion")
    # A completion checklist OR an authority matrix both constitute a
    # machine-enforced output/behaviour contract (T2 actors like the shepherd
    # carry authority-only contracts with no per-node completion checklist).
    return bool(completion) or bool(data.get("authority"))


def lint(path: Path) -> list[tuple[str, str, str]]:
    """Return [(severity, code, message)]."""
    raw: list[tuple[str, str, str]] = []
    def err(c: str, m: str) -> None:
        raw.append(("ERROR", c, m))

    def warn(c: str, m: str) -> None:
        raw.append(("WARN", c, m))

    text = path.read_text(encoding="utf-8")
    kind = detect_kind(path)
    if kind == "template":
        return []
    fm, body = split_frontmatter(text)
    lines = body.splitlines()

    # Parse x-lint overrides from the raw frontmatter text
    allowed_codes, override_reason = parse_xlint(text)
    # E9: override declared without a reason
    if allowed_codes and not override_reason:
        raw.append(("ERROR", "E9", "x-lint.allow declared without a reason field"))

    # E1 frontmatter description
    if kind in ("skill", "agent", "pointer"):
        desc = fm.get("description", "")
        if not desc:
            err("E1", "missing frontmatter description")
        else:
            cap = 15 if kind == "pointer" else 25
            if words(desc) > cap:
                err("E1", f"description {words(desc)}w > {cap}w cap for {kind}")
            # EMPTY_DESCRIPTION (plugin-eval): description present but < 20 chars
            # after stripping YAML folded/literal markers (">-", ">", "|").
            desc_content = _YAML_SCALAR_PREFIX.sub("", desc).strip()
            if desc_content and len(desc_content) < 20:
                err("E1", f"description too short ({len(desc_content)} chars < 20 minimum)")

    # E2 hedges on normative lines (keyword-style: MUST/DEFAULT/ASK/NOT)
    for i, ln in enumerate(lines, 1):
        if KEYWORD_LINE.match(ln):
            m = HEDGES.search(ln)
            if m:
                err("E2", f"line {i}: hedge '{m.group(0)}' — replace with an observable condition")

    # E3 model names outside routing steering
    if "subagent-routing" not in str(path) and kind != "agent":
        for i, ln in enumerate(lines, 1):
            if ln.strip().startswith(("#", "LEGEND")):
                continue
            m = MODEL_NAMES.search(ln)
            if m:
                err("E3", f"line {i}: model name '{m.group(0)}' in prose — route via steering-subagent-routing")

    # E5 agent output contract.
    # A bead-as-brief agent's output contract is its companion rules file
    # (.apm/rules/<name>.rules.json with a `completion` checklist) — the
    # machine-enforced spec of what it must produce (REPORTED comment, push,
    # handoff label, ...). That is strictly stronger than a prose section and
    # avoids duplicating the contract in two places, so a rules-backed agent
    # satisfies E5 without a prose "Output contract" heading.
    if kind == "agent":
        if _has_rules_contract(path, fm):
            pass  # rules file IS the output contract
        elif not re.search(r"^#+\s*Output|^OUTPUT", body, re.M):
            err("E5", "agent has no Output contract section (and no .apm/rules/<name>.rules.json)")
        else:
            if not CAPS_ENUM.search(body):
                warn("W5", "no CAPS verdict enum (PASS|FAIL style) found in output contract")
            if not re.search(r"\bCAP\b|\b\d+\s*w(ords)?\b|≤\s*\d+", body):
                err("E5", "output contract has no word cap")
            if not re.search(r"never reprint|paths? only|path:line", body, re.I):
                warn("W5", "no no-reprint rule in output contract")

    # E6 size caps
    n_lines = len([line for line in lines if line.strip()])
    caps = {"skill": 70, "context": 60, "pointer": 10, "agent": 90}
    if kind in caps and n_lines > caps[kind]:
        warn("W6", f"{n_lines} non-empty lines > {caps[kind]} target for {kind}")

    # E7 pointer shape. applyTo is optional: APM treats an omitted applyTo as
    # unconditional and folds the instruction into compiled context files.
    if kind == "pointer":
        if not re.search(r"\]\(\.\./context/.*\.context\.md\)", body):
            err("E7", "pointer does not link a ../context/*.context.md file")

    # E8 relative links resolve. Scans with code spans blanked: a doc that
    # DEMONSTRATES a link (`[x](../x.md)` as an example of good or bad practice)
    # is not making that link, and flagging it makes any doc about linking
    # unlintable.
    for m in re.finditer(r"\]\((?!https?://)([^)#]+)\)", _blank_code_spans(body)):
        target = (path.parent / m.group(1)).resolve()
        if not target.exists():
            err("E8", f"broken link: {m.group(1)}")

    # W9 duplicate rule lines (same normalized text twice)
    seen: dict[str, int] = {}
    for i, ln in enumerate(lines, 1):
        key = re.sub(r"\W+", " ", ln.lower()).strip()
        if len(key) > 30 and (KEYWORD_LINE.match(ln) or SIGIL_LINE.match(ln) or ln.strip().startswith("-")):
            if key in seen:
                warn("W9", f"line {i} duplicates line {seen[key]}")
            else:
                seen[key] = i

    # W10 OVER_CONSTRAINED (plugin-eval): skills with excessive MUST/NEVER/ALWAYS
    # density become brittle. Threshold of 15 matches plugin-eval. Only applied to
    # skills; context files legitimately carry dense normative rules for agents.
    if kind == "skill":
        mna_count = len(re.findall(r"\b(MUST|NEVER|ALWAYS)\b", text))
        if mna_count > _OVER_CONSTRAINED_THRESHOLD:
            warn(
                "W10",
                f"{mna_count} MUST/NEVER/ALWAYS directives > {_OVER_CONSTRAINED_THRESHOLD} threshold — "
                "overly prescriptive instructions reduce model flexibility",
            )

    # W11 MISSING_TRIGGER (plugin-eval): skill description lacks a recognised
    # trigger phrase, making it hard for the model to auto-invoke the skill.
    # Only skills are checked (agents and pointers use different routing).
    if kind == "skill":
        desc = fm.get("description", "")
        desc_content = _YAML_SCALAR_PREFIX.sub("", desc).strip()
        # Only warn when a non-trivial description is present but has no trigger phrase.
        if desc_content and len(desc_content) >= 20 and not _TRIGGER_PATTERN.search(desc_content):
            warn(
                "W11",
                'skill description lacks a trigger phrase (e.g. "Use when …", "Use for …", '
                '"Triggers on …") — without one the model cannot determine when to invoke it',
            )

    # W12 BLOATED_SKILL (plugin-eval): skills over 800 lines without a references/
    # subdirectory should offload supporting material to progressive disclosure.
    if kind == "skill":
        n_total = len([line for line in text.splitlines() if line.strip()])
        has_refs = (path.parent / "references").exists()
        if n_total > _BLOATED_LINE_THRESHOLD and not has_refs:
            warn(
                "W12",
                f"{n_total} non-empty lines without a references/ directory — "
                "large skills should offload supporting material to references/",
            )

    # Apply x-lint overrides: suppress allowed codes, emit OVERRIDDEN trace
    if not allowed_codes:
        return raw
    out: list[tuple[str, str, str]] = []
    for sev, code, msg in raw:
        if code in allowed_codes and override_reason:
            out.append(("OVERRIDDEN", code, f"{msg} (reason: {override_reason})"))
        else:
            out.append((sev, code, msg))
    return out


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    worst = 0
    for arg in argv:
        path = Path(arg)
        if not path.is_file():
            print(f"{arg}: not a file")
            worst = 1
            continue
        kind = detect_kind(path)
        findings = lint(path)
        # Filter out OVERRIDDEN for "OK" check (they are auditable but not errors)
        visible = [f for f in findings if f[0] != "OVERRIDDEN"]
        overridden = [f for f in findings if f[0] == "OVERRIDDEN"]
        if not findings:
            print(f"{arg} [{kind}]: OK")
            continue
        if not visible and overridden:
            print(f"{arg} [{kind}]: OK (with overrides)")
        for sev, code, msg in findings:
            print(f"{arg} [{kind}] {sev} {code}: {msg}")
            if sev == "ERROR":
                worst = 1
    return worst


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
