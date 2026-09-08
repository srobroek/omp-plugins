#!/usr/bin/env python3
"""Run slopvac 1.0.1 with Unicode-safe Vale patterns and fail-closed coverage."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import ExitStack, contextmanager
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import patch

SUPPORTED_VERSION = "1.0.1"
PATTERNS = {
    "prose-format.emoji-heading": r"[\U0001F300-\U0001FAFF☀-➿⬀-⯿️]",
    "ai-tells-formatting.emoji-list-markers": (
        r"(?m)^\s*(?:[-*+]\s+)?[\U0001F300-\U0001FAFF☀-➿⬀-⯿]️?\s"
    ),
}


class IncompleteRun(RuntimeError):
    """A score cannot establish that the requested rules ran."""


def require_version() -> None:
    installed = version("slopvac")
    if installed != SUPPORTED_VERSION:
        raise IncompleteRun(
            f"adapter requires slopvac {SUPPORTED_VERSION}, found {installed}; "
            "review the upstream compiler before changing this pin"
        )


def validate_report(data: object) -> None:
    if not isinstance(data, dict):
        raise IncompleteRun("Vale diagnostics must be a JSON object")
    for path, alerts in data.items():
        if not isinstance(path, str) or not isinstance(alerts, list):
            raise IncompleteRun("Vale diagnostics contain an invalid path or alert list")
        for alert in alerts:
            if not isinstance(alert, dict) or not all(
                isinstance(alert.get(key), str)
                for key in ("Check", "Message", "Severity", "Match")
            ):
                raise IncompleteRun("Vale diagnostics contain an invalid alert")
            span = alert.get("Span")
            if (
                not alert["Check"]
                or alert["Severity"] not in {"error", "warning", "suggestion"}
                or type(alert.get("Line")) is not int
                or alert["Line"] < 1
                or not isinstance(span, list)
                or len(span) != 2
                or any(type(value) is not int or value < 1 for value in span)
                or span[1] < span[0]
            ):
                raise IncompleteRun("Vale diagnostics contain an invalid location or check")


def checked_run(args, **kwargs):
    completed = subprocess.run(args, **kwargs)
    diagnostics = "--output=JSON" in args
    resolving = "ls-config" in args
    rejected_pattern = (
        "E201" in completed.stderr or "error parsing regexp" in completed.stderr
    )
    # Compiler probes may reject a pattern: upstream then executes it natively.
    if rejected_pattern and not diagnostics and not resolving:
        return completed
    if completed.returncode != 0 or completed.stderr.strip():
        raise IncompleteRun(
            f"Vale failed ({completed.returncode}): {completed.stderr.strip()}"
        )
    if diagnostics or resolving:
        try:
            data = json.loads(completed.stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            raise IncompleteRun("Vale returned empty or unparseable JSON") from exc
        if diagnostics:
            validate_report(data)
        elif (
            not isinstance(data, dict)
            or not isinstance(data.get("Checks"), list)
            or any(not isinstance(check, str) for check in data["Checks"])
        ):
            raise IncompleteRun("Vale returned an invalid resolved-checks report")
    return completed


def require_classification(ruleset, resolved, compiled) -> None:
    from slopvac.config import Severity
    from slopvac.engine import Engine
    from slopvac.model import RuleKind

    engine = Engine(ruleset.rules, resolved)
    active = {
        rule.qualified_id
        for rule in engine.rules
        if engine.severity_for(rule) is not Severity.OFF
    }
    judgement = {
        rule.qualified_id for rule in ruleset.rules if rule.kind is RuleKind.JUDGEMENT
    }
    all_rules = {rule.qualified_id for rule in ruleset.rules}
    native = {rule.rule_id for rule in compiled.native_rules}
    vale = {compiled.aliases.get(rule, rule) for rule in compiled.vale_rules}
    if (
        native & vale
        or native | vale != active
        or set(compiled.judgement_rules) != judgement
        or set(compiled.disabled_rules) != all_rules - active - judgement
        or not set(compiled.aliases).issubset(compiled.vale_rules)
    ):
        raise IncompleteRun("compiler did not classify the complete ruleset consistently")
    if compiled.notes:
        raise IncompleteRun("; ".join(compiled.notes))


@contextmanager
def adapted():
    require_version()
    from slopvac import cli, compile_vale, vale

    payload_for = compile_vale._payload_for
    compile_ruleset = cli.compile_ruleset
    lint_one = cli._lint_one
    inject_locale_rule = cli.inject_locale_rule

    def unicode_payload(rule, level):
        expected = PATTERNS.get(rule.qualified_id)
        if expected is not None:
            if rule.pattern != expected:
                raise IncompleteRun(f"upstream pattern changed: {rule.qualified_id}")
            # Only the two known Python escapes change; all other regex syntax stays.
            pattern = expected.replace(r"\U0001F300", chr(0x1F300)).replace(
                r"\U0001FAFF", chr(0x1FAFF)
            )
            rule = rule.model_copy(update={"pattern": pattern})
        elif rule.pattern and "\\U" in rule.pattern:
            raise IncompleteRun(f"unreviewed Unicode escape in {rule.qualified_id}")
        return payload_for(rule, level)

    def complete_compile(ruleset, resolved_config, *args, **kwargs):
        binary = kwargs.get("binary", "vale")
        if shutil.which(binary) is None:
            raise IncompleteRun(f"Vale executable is unavailable: {binary}")
        if not kwargs.get("validate", True):
            raise IncompleteRun("unvalidated compilation is not a prose gate")
        compiled = compile_ruleset(ruleset, resolved_config, *args, **kwargs)
        require_classification(ruleset, resolved_config, compiled)
        return compiled

    def complete_lint(*args, **kwargs):
        score = lint_one(*args, **kwargs)
        if score.unchecked:
            raise IncompleteRun("; ".join(score.unchecked))
        return score

    def complete_locale(*args, **kwargs):
        note = inject_locale_rule(*args, **kwargs)
        if note:
            raise IncompleteRun(note)
        return note

    backend = SimpleNamespace(run=checked_run, TimeoutExpired=subprocess.TimeoutExpired)
    with tempfile.TemporaryDirectory(prefix="prose-gate-") as cache, ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, {"SLOPVAC_CACHE_DIR": cache}))
        for module, name, replacement in (
            (compile_vale, "_payload_for", unicode_payload),
            (compile_vale, "subprocess", backend),
            (vale, "subprocess", backend),
            (cli, "compile_ruleset", complete_compile),
            (cli, "_lint_one", complete_lint),
            (cli, "inject_locale_rule", complete_locale),
        ):
            stack.enter_context(patch.object(module, name, replacement))
        yield cli


def main() -> None:
    try:
        with adapted() as cli:
            cli.main()
    except (IncompleteRun, ImportError, OSError, ValueError, TypeError, KeyError) as exc:
        print(f"prose-gate: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
