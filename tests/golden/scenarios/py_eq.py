"""Python ``==`` between the values a model file and a model hold: bool, int
and float as one numeric tower, ints and floats around 2**53 and past 2**63,
infinities and NaN, the strings the parser makes of bare constants, lists
element-wise, dicts whatever their key order, a dict against a list, and
strings by code point.

Each pair's two sides come from separate constructions, so no NaN (or any
other) object is shared between them and Python's identity shortcut for
containers never decides a pair. Every pair is recorded both ways round."""

from __future__ import annotations

from typing import Any

from ..driver import scenario
from ..tagged import tag


def _pairs() -> list[tuple[Any, Any]]:
    nested_a = {"x": {"y": {"z": [1, {"p": 1, "q": 2}], "w": None}, "v": True}}
    nested_b = {"x": {"v": 1.0, "y": {"w": None, "z": [1.0, {"q": 2, "p": True}]}}}
    return [
        (True, 1),
        (True, 1.0),
        (1, 1.0),
        (False, 0),
        (False, -0.0),
        (False, 0.0),
        (0, -0.0),
        (0, 0.0),
        (-0.0, 0.0),
        (True, 2),
        (None, 0),
        (None, None),
        ("1", 1),
        ("", None),
        (2**53, float(2**53)),
        (2**53 + 1, float(2**53)),
        (2**64, float(2**64)),
        (-(2**63), float(-(2**63))),
        (10**400, float("inf")),
        (float("inf"), float("inf")),
        (float("nan"), float("nan")),
        (0.1 + 0.2, 0.3),
        ("NaN", float("nan")),
        ("Infinity", float("inf")),
        ([1, 2], [1.0, 2]),
        ([1], [1, 2]),
        ([], {}),
        ({"a": 1, "b": [True]}, {"b": [1.0], "a": 1}),
        ({"a": 1}, {"a": 1, "b": None}),
        ({"a": 1}, [["a", 1]]),
        (nested_a, nested_b),
        ("\u00e9", "e\u0301"),
        ("\U0001d11e", "\U0001d11e"),
    ]


@scenario("py_eq")
def py_eq() -> Any:
    lefts = [a for a, _ in _pairs()]
    rights = [b for _, b in _pairs()]
    pairs: list[dict[str, Any]] = []
    for a, b in zip(lefts, rights, strict=True):
        pairs.append({"a": tag(a), "b": tag(b), "eq": a == b})
        pairs.append({"a": tag(b), "b": tag(a), "eq": b == a})
    return {"pairs": pairs}
