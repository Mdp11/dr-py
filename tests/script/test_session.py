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


# --- Facade-side serialization (guest-side, M2/M3) -----


from data_rover.core.script.bridge import BridgeDispatcher
from data_rover.core.script.facade_src import FACADE_SOURCE


def _facade_ns(model) -> dict:
    dispatcher = BridgeDispatcher(
        model, record_ops=False, max_ops=10, max_op_bytes=1024, page_limit=500
    )
    ns: dict = {"_transport": dispatcher.dispatch}
    exec(FACADE_SOURCE, ns)
    return ns


def test_serialize_value_shapes(small_model) -> None:
    ns = _facade_ns(small_model)
    ser = ns["_dr_serialize_entry_result"]
    el = ns["dr"].element(next(iter(small_model.elements)))
    assert ser("value", 3) == {"kind": "scalar", "value": 3}
    assert ser("value", None) == {"kind": "scalar", "value": None}
    assert ser("value", ["a", 1, None]) == {"kind": "scalars", "values": ["a", 1, None]}
    assert ser("value", el) == {"kind": "element", "id": el.id}
    assert ser("value", [el, el]) == {"kind": "elements", "ids": [el.id, el.id]}
    with pytest.raises(ValueError):
        ser("value", {"a": 1})
    with pytest.raises(ValueError):
        ser("value", [el, 1])  # mixed Element/scalar list


def test_serialize_step_shapes(small_model) -> None:
    ns = _facade_ns(small_model)
    ser = ns["_dr_serialize_entry_result"]
    el = ns["dr"].element(next(iter(small_model.elements)))
    assert ser("step", [el, "raw-id"]) == {"ids": [el.id, "raw-id"]}
    assert ser("step", None) == {"ids": []}
    with pytest.raises(ValueError):
        ser("step", 42)
    with pytest.raises(ValueError):
        ser("step", [1])
