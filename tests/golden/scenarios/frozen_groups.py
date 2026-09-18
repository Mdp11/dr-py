"""Which values the uniqueness signature (``_frozen``) treats as equal."""

from __future__ import annotations

from typing import Any

from data_rover.core.model.indexes import _frozen

from ..driver import scenario
from ..tagged import tag

_FROZEN_VALUES: list[Any] = [
    1, 1.0, True, 0, 0.0, -0.0, False, 2, 2.5, "1", "", None, "None",
    2**53, float(2**53), 2**53 + 1, 2**64, float(2**64), 1e300,
    [], [1], [1.0], [True], [1, 2], [2, 1], [[1]], ["a", 1],
    {}, {"a": 1}, {"a": 1.0}, {"a": 1, "b": 2}, {"b": 2, "a": 1}, [["a", 1]],
    {"a": [1, 2]}, {"a": [1.0, 2.0]}, "a", "A",
]  # fmt: skip


@scenario("frozen_groups")
def frozen_groups() -> Any:
    groups: dict[Any, list[int]] = {}
    for index, value in enumerate(_FROZEN_VALUES):
        groups.setdefault(_frozen(value), []).append(index)
    return {
        "values": [tag(value) for value in _FROZEN_VALUES],
        "groups": sorted(groups.values()),
    }
