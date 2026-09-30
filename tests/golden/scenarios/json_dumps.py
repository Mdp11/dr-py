"""``json.dumps`` output, compact and indented, as the writers configure it."""

from __future__ import annotations

import json
from typing import Any

from ..driver import scenario
from ..tagged import tag

_DUMP_VALUES: list[Any] = [
    None, True, False, 0, -5, 2**53, 2**64, 1.0, -0.0, 1e16, 1e-7, 0.1,
    "", "plain", 'quote " backslash \\ slash /', "ctl \x00 \x1f \x7f \b \f \n \r \t",
    "caf\u00e9 \u4e2d\u6587 \U0001f600 \u2028 \u2029",
    [], {}, [[]], [{}], {"a": []}, {"a": {}},
    [1, 2.5, "x", None, True],
    {"id": "e1", "properties": {"name": "N", "list": [1, [2, {"z": 1.5}]], "empty": {}}, "rev": 0},
]  # fmt: skip

# Written with bare ``json.dumps(value)``: ascii escapes, spaced separators, NaN allowed.
_DEFAULT_VALUES: list[Any] = [
    {"a": [1, {"b": None}], "c": {"d": [True, "x"]}},
    [], {}, 1, 1.0, 1e22, 2**60, True, None,
    "\u00e9", " ", "\U0001f600", "\x00\x1f\x7f", '"', "\\",
    float("nan"), float("inf"), float("-inf"),
    [float("nan"), {"k": float("inf")}],
]  # fmt: skip


@scenario("json_dumps")
def json_dumps() -> Any:
    return [
        {
            "value": tag(value),
            "compact": json.dumps(
                value, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            ),
            "indented": json.dumps(
                value, indent=2, ensure_ascii=False, allow_nan=False
            ),
        }
        for value in _DUMP_VALUES
    ] + [{"value": tag(value), "default": json.dumps(value)} for value in _DEFAULT_VALUES]
