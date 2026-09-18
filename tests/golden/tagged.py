"""A parser-independent rendering of JSON-ish values.

Fixture files are read with a plain JSON parser, which cannot tell ``1`` from
``1.0`` or hold an integer past 2^53. Tagging keeps every distinction: ints as
decimal text, floats as their IEEE-754 bits, dicts as ordered pairs.
"""

from __future__ import annotations

import struct
from typing import Any


def tag(value: Any) -> dict[str, Any]:
    if value is None:
        return {"t": "null"}
    if isinstance(value, bool):
        return {"t": "bool", "v": value}
    if isinstance(value, int):
        return {"t": "int", "v": str(value)}
    if isinstance(value, float):
        return {"t": "float", "hex": struct.pack(">d", value).hex()}
    if isinstance(value, str):
        return {"t": "str", "v": value}
    if isinstance(value, list):
        return {"t": "list", "v": [tag(item) for item in value]}
    if isinstance(value, dict):
        return {"t": "dict", "v": [[key, tag(item)] for key, item in value.items()]}
    raise TypeError(f"cannot tag {type(value).__name__}")
