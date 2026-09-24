"""``_js_str`` and ``_to_number`` (the criteria matchers' JS-parity coercion,
Python's ``str()`` and ``float()`` in fact) and ``float()`` itself."""

from __future__ import annotations

from typing import Any

from data_rover.core.search.criteria import _js_str, _to_number

from ..coerce_tables import space_points
from ..driver import scenario
from ..tagged import tag

_MISSING = object()

_ESCAPED = 'it\'s "quoted"\\back\ttab'
_CONTAINER_SCALARS: list[Any] = [1, 2**64, 1.0, 1.5, True, False, None, _ESCAPED]

_JS_STR_VALUES: list[Any] = [
    0, -5, 1, 2**53, 2**64, -(2**64),
    1.0, -1.0, 0.5, 1.5, -0.0, 1e16, 1e21, 1e23, 5e-324, 1e308, 1e-5,
    True, False, None,
    "", "plain", _ESCAPED,
    list(_CONTAINER_SCALARS),
    {"k": "v", "n": list(_CONTAINER_SCALARS), "esc": _ESCAPED},
]  # fmt: skip

# Texts that show float()'s grammar: underscores, whitespace and non-ASCII digits,
# infinities and NaN, a base prefix and a stray thousands separator.
_FLOAT_GRAMMAR_TEXTS = [
    "1_000", " 1.5 ", "inf", "-Infinity", "nan", "٣", "１２", "\xa01\xa0",
    ".5", "5.", "+1", "0x10", "1__0", "1 000",
]  # fmt: skip

# One decimal digit ('3') from each of ten scripts unicodedata knows.
_SCRIPT_DIGITS = ["٣", "۳", "३", "৩", "૩", "௩", "๓", "໓", "၃", "３"]

_UNDERSCORE_TEXTS = [
    "_1", "1_", "1__0", "1_0", "1_.0", "1._0", "1.0_", "_1.0", "1.0_5",
    "1_0.5", "1.5_", "1e_1", "1_e1", "1e1_", "1e1_0", "1_e_1", "+_1", "-_1",
    "1_+1", "1_000.5", "1.0_5e1_0",
]  # fmt: skip

_EXPONENT_TEXTS = [
    "1e5", "1E5", "1e+5", "1e-5", "1E+5", "1E-5", "1.5e10", ".5e10", "5.e10",
    "1e", "1e+", "1e-", "e5", "1ee5", "1e+05", "1e-05",
]  # fmt: skip

_INF_NAN_TEXTS = [
    "inf", "INF", "Inf", "-inf", "+inf", "infinity", "INFINITY", "Infinity",
    "-Infinity", "+Infinity", "nan", "NAN", "NaN", "-nan", "+nan", "infi",
    "infinit", "naan",
]  # fmt: skip

_WHITESPACE_TEXTS = [chr(cp) + "1" + chr(cp) for cp in space_points()]

_TEXT_CASES = (
    _FLOAT_GRAMMAR_TEXTS
    + _SCRIPT_DIGITS
    + _UNDERSCORE_TEXTS
    + _EXPONENT_TEXTS
    + _INF_NAN_TEXTS
    + _WHITESPACE_TEXTS
)

_NON_STRING_TO_NUMBER_CASES: list[Any] = [True, False, None, [1, 2], [], 10**400]


def _tag_input(value: Any) -> Any:
    return {"missing": True} if value is _MISSING else tag(value)


def _to_number_pair(value: Any) -> list[Any]:
    try:
        result = _to_number(value)
    except OverflowError as exc:
        return [_tag_input(value), {"error": str(exc)}]
    if result != result:  # NaN: nothing else in a float compares unequal to itself
        return [_tag_input(value), "nan"]
    return [_tag_input(value), tag(result)]


def _float_of_pair(text: str) -> list[Any]:
    try:
        value = float(text)
    except ValueError:
        return [text, None]
    return [text, tag(value)]


@scenario("py_coerce")
def py_coerce() -> Any:
    to_number_inputs: list[Any] = [*_NON_STRING_TO_NUMBER_CASES, _MISSING, *_TEXT_CASES]
    return {
        "js_str": [[tag(v), _js_str(v)] for v in _JS_STR_VALUES],
        "to_number": [_to_number_pair(v) for v in to_number_inputs],
        "float_of": [_float_of_pair(text) for text in _TEXT_CASES],
    }
