from __future__ import annotations

import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
from cadmodel import fillets, runner  # noqa: E402


class FilletFallbackTests(unittest.TestCase):
    class StdFail_NotDone(Exception):
        pass

    def test_successful_smaller_radius_is_returned_after_kernel_retry(self) -> None:
        shape = mock.Mock()
        edge = object()
        failed = self.StdFail_NotDone("too large")
        shape.fillet.side_effect = [failed, "small-radius-shape"]
        result = fillets.fillet_edge(shape, edge, 2.0)
        self.assertEqual(result, "small-radius-shape")
        self.assertEqual([call.args for call in shape.fillet.call_args_list], [(2.0, [edge]), (1.0, [edge])])

    def test_exhausted_cosmetic_edge_is_logged_and_leaves_shape_unchanged(self) -> None:
        shape = mock.Mock()
        shape.fillet.side_effect = self.StdFail_NotDone("cannot build")
        with self.assertLogs("cadmodel.fillets", level="WARNING") as captured:
            result = fillets.fillet_edge(shape, "rim", 1.0, retries=2, name="rim")
        self.assertIs(result, shape)
        self.assertEqual(shape.fillet.call_count, 3)
        self.assertIn("skipped non-functional fillet on rim", captured.output[0])

    def test_functional_edge_raises_last_kernel_failure(self) -> None:
        shape = mock.Mock()
        errors = [self.StdFail_NotDone("first"), self.StdFail_NotDone("last")]
        shape.fillet.side_effect = errors
        with self.assertRaises(self.StdFail_NotDone) as caught:
            fillets.fillet_edge(shape, "seat", 1.0, retries=1, functional=True)
        self.assertIs(caught.exception, errors[-1])

    def test_other_kernel_errors_are_not_treated_as_cosmetic_fallback(self) -> None:
        shape = mock.Mock()
        shape.fillet.side_effect = RuntimeError("bad API")
        with self.assertRaisesRegex(RuntimeError, "bad API"):
            fillets.fillet_edge(shape, "edge", 1.0)
        self.assertEqual(shape.fillet.call_count, 1)

    def test_model_warning_is_carried_in_runner_part_result(self) -> None:
        original = runner._build_part
        request = {"pn": "TST-0001", "model": "model.py"}

        def build_with_warning(_kernel, _request):
            logging.getLogger("cadmodel.fillets").warning("skipped edge")
            return {"ok": True}

        runner._build_part = build_with_warning
        try:
            self.assertEqual(runner.build_part("test", request),
                             {"ok": True, "warnings": ["skipped edge"]})
        finally:
            runner._build_part = original

if __name__ == "__main__":
    unittest.main()