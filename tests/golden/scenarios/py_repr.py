"""``repr(str)``, which the core's error messages embed."""

from __future__ import annotations

from typing import Any

from ..driver import scenario

_REPR_STRINGS = [
    "", "plain", "it's", 'say "hi"', "both ' and \"", "back\\slash", "tab\there",
    "line\nbreak", "cr\rhere", "nul\x00", "del\x7f", "nbsp\u00a0", "caf\u00e9",
    "\u4e2d\u6587", "zwj\u200d", "line-sep\u2028", "\U0001f600", "space ok",
    "e_000001", "tmp_abc", "bell\x07",
]  # fmt: skip


@scenario("py_repr")
def py_repr() -> Any:
    return [{"s": s, "repr": repr(s)} for s in _REPR_STRINGS]
