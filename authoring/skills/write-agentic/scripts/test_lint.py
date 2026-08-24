#!/usr/bin/env python3
"""Tests for lint.py — x-lint override mechanism and core rules.

Run: pytest packages/write-agentic/.apm/skills/write-agentic/scripts/test_lint.py
"""
import importlib.util
import os
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))


def _load():
    path = os.path.join(HERE, "lint.py")
    spec = importlib.util.spec_from_file_location("lint", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


lint_mod = _load()


def _write(tmp_path: Path, name: str, content: str) -> Path:
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# parse_xlint
# ---------------------------------------------------------------------------

class TestParseXlint:
    def test_no_xlint(self):
        text = "---\nname: foo\ndescription: bar\n---\nbody"
        codes, reason = lint_mod.parse_xlint(text)
        assert codes == set()
        assert reason == ""

    def test_inline_list(self):
        text = "---\nx-lint:\n  allow: [E1, E3]\n  reason: \"test reason\"\n---\nbody"
        codes, reason = lint_mod.parse_xlint(text)
        assert codes == {"E1", "E3"}
        assert reason == "test reason"

    def test_block_list(self):
        text = "---\nx-lint:\n  allow:\n    - E1\n    - W9\n  reason: block reason\n---\nbody"
        codes, reason = lint_mod.parse_xlint(text)
        assert codes == {"E1", "W9"}
        assert reason == "block reason"

    def test_no_frontmatter(self):
        codes, reason = lint_mod.parse_xlint("no frontmatter here")
        assert codes == set()
        assert reason == ""

    def test_missing_reason_returns_empty_reason(self):
        text = "---\nx-lint:\n  allow: [E1]\n---\nbody"
        codes, reason = lint_mod.parse_xlint(text)
        assert "E1" in codes
        assert reason == ""

    def test_w_code_allowed(self):
        text = "---\nx-lint:\n  allow: [W9]\n  reason: \"acceptable duplication\"\n---\nbody"
        codes, reason = lint_mod.parse_xlint(text)
        assert "W9" in codes
        assert reason == "acceptable duplication"


# ---------------------------------------------------------------------------
# Override behavior in lint()
# ---------------------------------------------------------------------------

SKILL_TEMPLATE_LONG = """\
---
name: test-skill
description: {desc}
x-lint:
  allow: [{codes}]
  reason: "{reason}"
---

# Test Skill

MUST do something.
"""

SKILL_TEMPLATE_NO_OVERRIDE = """\
---
name: test-skill
description: {desc}
---

# Test Skill

MUST do something.
"""


class TestOverrideMechanism:
    def test_suppressed_e1_prints_overridden(self, tmp_path):
        # 30-word description on a skill (cap is 25)
        desc = "word " * 30
        content = SKILL_TEMPLATE_LONG.format(
            desc=desc.strip(), codes="E1", reason="routing depends on full description"
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        codes = {code for _, code, _ in findings}
        sevs = {sev for sev, _, _ in findings}
        assert "E1" not in codes or all(
            sev == "OVERRIDDEN" for sev, code, _ in findings if code == "E1"
        ), "E1 should be OVERRIDDEN, not ERROR"
        assert "OVERRIDDEN" in sevs
        assert "ERROR" not in sevs

    def test_overridden_message_contains_reason(self, tmp_path):
        desc = "word " * 30
        content = SKILL_TEMPLATE_LONG.format(
            desc=desc.strip(), codes="E1", reason="routing depends on full description"
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        overridden = [(sev, code, msg) for sev, code, msg in findings if sev == "OVERRIDDEN"]
        assert overridden, "expected at least one OVERRIDDEN finding"
        assert "routing depends on full description" in overridden[0][2]

    def test_missing_reason_is_e9(self, tmp_path):
        desc = "word " * 30
        content = f"""\
---
name: test-skill
description: {desc.strip()}
x-lint:
  allow: [E1]
---

# Test Skill

MUST do something.
"""
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        error_codes = [code for sev, code, _ in findings if sev == "ERROR"]
        assert "E9" in error_codes, f"expected E9, got {error_codes}"

    def test_non_overridden_error_still_errors(self, tmp_path):
        # Override E1 but not E3 — model name in prose should still error
        desc = "word " * 30
        content = f"""\
---
name: test-skill
description: {desc.strip()}
x-lint:
  allow: [E1]
  reason: "routing needs it"
---

# Test Skill

MUST do something.
MUST prefer haiku for cheap tasks.
"""
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        error_codes = [code for sev, code, _ in findings if sev == "ERROR"]
        assert "E3" in error_codes

    def test_no_override_e1_is_error(self, tmp_path):
        desc = "word " * 30
        content = SKILL_TEMPLATE_NO_OVERRIDE.format(desc=desc.strip())
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        error_codes = [code for sev, code, _ in findings if sev == "ERROR"]
        assert "E1" in error_codes

    def test_allow_w_code(self, tmp_path):
        # Two identical MUST lines (W9) with override
        content = """\
---
name: test-skill
description: short skill description here nice
x-lint:
  allow: [W9]
  reason: "duplicate rules needed for emphasis in this reference doc"
---

# Test

- MUST always check the file path before editing any document in scope
- MUST always check the file path before editing any document in scope
"""
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        # W9 should be OVERRIDDEN, not WARN
        for sev, code, msg in findings:
            if code == "W9":
                assert sev == "OVERRIDDEN", f"W9 should be OVERRIDDEN, got {sev}"

    def test_clean_file_returns_empty(self, tmp_path):
        content = """\
---
name: test-skill
description: Short clean skill description here.
---

# Test Skill

MUST do something specific and verifiable.
"""
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        errors = [f for f in findings if f[0] == "ERROR"]
        assert errors == []


# ---------------------------------------------------------------------------
# Pointer shape
# ---------------------------------------------------------------------------

class TestPointerShape:
    def _pointer(self, tmp_path: Path, frontmatter: str) -> Path:
        context_dir = tmp_path / "context"
        context_dir.mkdir()
        (context_dir / "rules.context.md").write_text("# Rules\n", encoding="utf-8")
        instructions_dir = tmp_path / "instructions"
        instructions_dir.mkdir()
        return _write(
            instructions_dir,
            "rules.instructions.md",
            f"""\
---
description: Route to the detailed rules.
{frontmatter}---

Read [rules](../context/rules.context.md).
""",
        )

    def test_unconditional_pointer_may_omit_apply_to(self, tmp_path):
        findings = lint_mod.lint(self._pointer(tmp_path, ""))
        assert not [f for f in findings if f[0] == "ERROR"]

    def test_scoped_pointer_may_include_apply_to(self, tmp_path):
        findings = lint_mod.lint(
            self._pointer(tmp_path, 'applyTo: "**/*.py"\n')
        )
        assert not [f for f in findings if f[0] == "ERROR"]

    def test_pointer_still_requires_context_link(self, tmp_path):
        path = _write(
            tmp_path,
            "rules.instructions.md",
            """\
---
description: Route to the detailed rules.
---

Rules are documented elsewhere.
""",
        )
        findings = lint_mod.lint(path)
        assert any(
            severity == "ERROR" and code == "E7"
            for severity, code, _ in findings
        )


# ---------------------------------------------------------------------------
# main() exit code with overrides
# ---------------------------------------------------------------------------

class TestMainExitCode:
    def test_overridden_only_exits_0(self, tmp_path, capsys):
        desc = "word " * 30
        content = SKILL_TEMPLATE_LONG.format(
            desc=desc.strip(), codes="E1", reason="routing depends on full description"
        )
        p = _write(tmp_path, "SKILL.md", content)
        rc = lint_mod.main([str(p)])
        assert rc == 0, "overridden-only file should exit 0"

    def test_real_error_exits_1(self, tmp_path):
        desc = "word " * 30
        content = SKILL_TEMPLATE_NO_OVERRIDE.format(desc=desc.strip())
        p = _write(tmp_path, "SKILL.md", content)
        rc = lint_mod.main([str(p)])
        assert rc == 1

    def test_e9_exits_1(self, tmp_path):
        desc = "word " * 30
        content = f"""\
---
name: test-skill
description: {desc.strip()}
x-lint:
  allow: [E1]
---

# Test Skill

MUST do something.
"""
        p = _write(tmp_path, "SKILL.md", content)
        rc = lint_mod.main([str(p)])
        assert rc == 1, "missing reason should be E9 → exit 1"


# ---------------------------------------------------------------------------
# Anti-pattern rules ported from plugin-eval (W10/W11/W12, E1 extension)
# ---------------------------------------------------------------------------

_SKILL_BASE = """\
---
name: {name}
description: {desc}
---

# {name}

{body}
"""


class TestAntiPatternRules:
    # --- E1 EMPTY_DESCRIPTION extension ---

    def test_e1_short_description_under_20_chars(self, tmp_path):
        content = _SKILL_BASE.format(
            name="short-desc-skill",
            desc="Too brief.",  # 9 chars
            body="MUST do something.",
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        error_codes = [code for sev, code, _ in findings if sev == "ERROR"]
        assert "E1" in error_codes, "description under 20 chars should be E1"

    def test_e1_yaml_folded_description_not_flagged_as_short(self, tmp_path):
        # ">-" folded YAML marker must not count toward the char minimum
        content = """\
---
name: folded-desc-skill
description: >-
  This is a long enough description to not trigger the short-desc check.
---

# folded-desc-skill

MUST do something.
"""
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        error_codes = [code for sev, code, _ in findings if sev == "ERROR"]
        assert "E1" not in error_codes, "folded YAML description should not be flagged"

    def test_e1_description_exactly_20_chars_is_clean(self, tmp_path):
        content = _SKILL_BASE.format(
            name="exact-skill",
            desc="Use when you need it.",  # exactly 21 chars — safe
            body="MUST do something.",
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        e1_errors = [msg for sev, code, msg in findings if sev == "ERROR" and code == "E1"]
        short_desc_errors = [m for m in e1_errors if "too short" in m]
        assert short_desc_errors == []

    # --- W10 OVER_CONSTRAINED ---

    def test_w10_over_constrained_skill(self, tmp_path):
        # 16 MUST/NEVER/ALWAYS directives — above the threshold of 15
        musts = "\n".join(f"MUST do step {i}." for i in range(16))
        content = _SKILL_BASE.format(
            name="over-constrained",
            desc="Use when you need to do many constrained things.",
            body=musts,
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W10" in warn_codes, "16 MUST directives should trigger W10"

    def test_w10_at_threshold_not_triggered(self, tmp_path):
        # exactly 15 — should NOT trigger
        musts = "\n".join(f"MUST do step {i}." for i in range(15))
        content = _SKILL_BASE.format(
            name="at-threshold",
            desc="Use when you need exactly fifteen constraints.",
            body=musts,
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W10" not in warn_codes, "exactly 15 should not trigger W10"

    def test_w10_not_applied_to_context(self, tmp_path):
        # context files legitimately carry dense rules
        musts = "\n".join(f"MUST do step {i}." for i in range(20))
        content = f"# dense context\n\n{musts}\n"
        p = _write(tmp_path, "rules.context.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W10" not in warn_codes, "W10 must not fire on context files"

    # --- W11 MISSING_TRIGGER ---

    def test_w11_description_with_use_when(self, tmp_path):
        content = _SKILL_BASE.format(
            name="triggered-skill",
            desc="Use when you need to audit code for smells.",
            body="MUST check everything.",
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W11" not in warn_codes, '"Use when" should satisfy trigger check'

    def test_w11_description_with_use_for(self, tmp_path):
        content = _SKILL_BASE.format(
            name="for-triggered-skill",
            desc="Use for running lint checks on the project.",
            body="MUST check everything.",
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W11" not in warn_codes, '"Use for" should satisfy trigger check'

    def test_w11_missing_trigger_warns(self, tmp_path):
        content = _SKILL_BASE.format(
            name="no-trigger-skill",
            desc="Manages isolated worktrees for delegated repository agents.",
            body="MUST check everything.",
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W11" in warn_codes, "description without trigger phrase should warn W11"

    def test_w11_not_applied_to_agent(self, tmp_path):
        content = """\
---
name: my-agent
description: Manages isolated operations without any trigger phrase.
---

# My Agent

## Output

PASS|FAIL verdict. CAP 100 words. Never reprint paths only.
"""
        p = _write(tmp_path, "my-agent.agent.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W11" not in warn_codes, "W11 must not fire on agent files"

    # --- W12 BLOATED_SKILL ---

    def test_w12_bloated_skill_without_references(self, tmp_path):
        # >800 non-empty lines, no references/ dir
        body = "\n".join(f"Line of content number {i}." for i in range(850))
        content = _SKILL_BASE.format(
            name="bloated-skill",
            desc="Use when you need this very large skill.",
            body=body,
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W12" in warn_codes, "skill over 800 lines without references/ should warn W12"

    def test_w12_bloated_skill_with_references_no_warn(self, tmp_path):
        # >800 non-empty lines BUT references/ dir exists — acceptable
        refs_dir = tmp_path / "references"
        refs_dir.mkdir()
        (refs_dir / "extra.md").write_text("# Extra reference content\n", encoding="utf-8")
        body = "\n".join(f"Line of content number {i}." for i in range(850))
        content = _SKILL_BASE.format(
            name="big-but-structured-skill",
            desc="Use when you need this large but well-structured skill.",
            body=body,
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W12" not in warn_codes, "references/ dir should suppress W12"

    def test_w12_under_threshold_no_warn(self, tmp_path):
        content = _SKILL_BASE.format(
            name="normal-skill",
            desc="Use when you need this normal-sized skill.",
            body="MUST do something reasonable.",
        )
        p = _write(tmp_path, "SKILL.md", content)
        findings = lint_mod.lint(p)
        warn_codes = [code for sev, code, _ in findings if sev == "WARN"]
        assert "W12" not in warn_codes, "small skill should not trigger W12"
