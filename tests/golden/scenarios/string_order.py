"""Python orders ``str`` by code point; the engine must too."""

from __future__ import annotations

import random
from typing import Any

from ..driver import scenario

_SEED = 20260918

_STRINGS = [
    "", "a", "A", "b", "ab", "a b", "Z", "z", "~", "\u00e9", "e\u0301", "\u4e2d",
    "\ud7ff", "\ue000", "\uffff", "\U00010000", "\U0001f600", "\U0010ffff",
    "x\ue000", "x\U00010000", "x\uffff", "x\U0001f600y", "x\U0001f600", "x\U0001f601",
    "name-10", "name-2", "Name-2",
]  # fmt: skip


@scenario("string_order")
def string_order() -> Any:
    rng = random.Random(_SEED)
    shuffled = list(_STRINGS)
    rng.shuffle(shuffled)
    return {"input": shuffled, "sorted": sorted(shuffled)}
