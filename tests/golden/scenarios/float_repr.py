"""``repr(float)`` over edge cases and a seeded sample of all doubles."""

from __future__ import annotations

import random
import struct
from typing import Any

from ..driver import scenario

_SEED = 20260918

_EDGE_DOUBLES = [
    0.0, -0.0, 1.0, -1.0, 5.0, 0.1, 0.5, 1.5, 100.0, 123.456,
    1e15, 1e16, 1e17, 9999999999999998.0, 1e21, 1e22, 1.5e300,
    1e-3, 1e-4, 1e-5, 1.234e-5, 1e-7, 5e-324, 2.2250738585072014e-308,
    1.7976931348623157e308, 0.30000000000000004, 2.0**53, 2.0**53 + 2,
    1 / 3, 2 / 3, 1e100, 123456789012345680.0,
]  # fmt: skip


def _hex(x: float) -> str:
    return struct.pack(">d", x).hex()


@scenario("float_repr")
def float_repr() -> Any:
    rng = random.Random(_SEED)
    doubles = list(_EDGE_DOUBLES)
    while len(doubles) < 2000:
        (x,) = struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))
        if x == x and x not in (float("inf"), float("-inf")):
            doubles.append(x)
    return [{"hex": _hex(x), "repr": repr(x)} for x in doubles]
