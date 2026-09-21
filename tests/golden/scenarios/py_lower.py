"""``str.lower()`` and ``str.strip()``, which the read routes' search applies."""

from __future__ import annotations

import sys
import unicodedata
from typing import Any

from ..driver import scenario
from ..lower_tables import case_ignorable_ranges, cased_ranges

# Unassigned in Python's Unicode, lowered by a host that carries a later one.
_NEWER = "꟎꟒꟔" + "".join(chr(cp) for cp in range(0x16EA0, 0x16EB9))

_STRINGS = [
    "Σ", "ΑΣ", "ΑΣ.", "ΑΣΑ",
    "ΑΣ́", "Α­Σ", "ΣΣ",
    "ὈΔΥΣΣΕΎΣ", "İstanbul", "ẞ",
    "K", "\U00010400\U00010401", _NEWER, "MiXeD ascii 123", "",
]  # fmt: skip

_STRIP_POINTS = [
    "\x1c", "\x1d", "\x1e", "\x1f", "\x85", "﻿", " ", "　",
]  # fmt: skip


def _strip_inputs() -> list[str]:
    each = [c + "x" + c + "y" + c for c in _STRIP_POINTS]
    every = "".join(_STRIP_POINTS)
    return [*each, every + "x" + every + "y" + every, " \t\n\r\x0b\x0cx y "]


def _surrogate(cp: int) -> bool:
    return 0xD800 <= cp <= 0xDFFF


@scenario("py_lower")
def py_lower() -> Any:
    points = [cp for cp in range(sys.maxunicode + 1) if not _surrogate(cp)]
    return {
        "unicode": unicodedata.unidata_version,
        "lower": [[cp, chr(cp).lower()] for cp in points if chr(cp).lower() != chr(cp)],
        "cased": [list(r) for r in cased_ranges()],
        "ignorable": [list(r) for r in case_ignorable_ranges()],
        "strings": [[s, s.lower()] for s in _STRINGS],
        "space": [cp for cp in points if chr(cp).isspace()],
        "stripped": [[s, s.strip()] for s in _strip_inputs()],
    }
