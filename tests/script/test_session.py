"""Session-protocol layer tests: ScriptBudget, decode_call_payload (host-side
validation of the untrusted guest's tagged call payloads)."""

from __future__ import annotations

import pytest

from data_rover.core.script.runner import ScriptBudget, decode_call_payload


def test_budget_remaining_and_exhausted() -> None:
    b = ScriptBudget.start(60)
    assert 0 < b.remaining() <= 60
    assert not b.exhausted
    spent = ScriptBudget(deadline=0.0)  # monotonic 0 is always in the past
    assert spent.remaining() == 0.0
    assert spent.exhausted


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "scalar", "value": 3},
        {"kind": "scalar", "value": None},
        {"kind": "scalars", "values": ["a", 1, None, True]},
        {"kind": "element", "id": "e1"},
        {"kind": "elements", "ids": ["e1", "e2"]},
    ],
)
def test_decode_value_payloads_accepted(payload: dict) -> None:
    decoded, msg = decode_call_payload("value", payload)
    assert msg is None
    assert decoded == payload


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"kind": "scalar", "value": object},
        {"kind": "scalars", "values": [{"nested": 1}]},
        {"kind": "element", "id": 7},
        {"kind": "elements", "ids": ["e1", 2]},
        {"kind": "mystery"},
        {"ids": ["e1"]},  # step shape is not a value shape
    ],
)
def test_decode_value_payloads_rejected(payload: object) -> None:
    decoded, msg = decode_call_payload("value", payload)
    assert decoded is None
    assert msg is not None


def test_decode_step_payloads() -> None:
    decoded, msg = decode_call_payload("step", {"ids": ["a", "b"]})
    assert (decoded, msg) == ({"ids": ["a", "b"]}, None)
    for bad in (None, {"ids": "a"}, {"ids": [1]}, {"kind": "scalar", "value": 1}):
        decoded, msg = decode_call_payload("step", bad)
        assert decoded is None and msg is not None
