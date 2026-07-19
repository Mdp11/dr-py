"""Session-protocol layer tests: ScriptBudget, decode_call_payload (host-side
validation of the untrusted guest's tagged call payloads)."""

from __future__ import annotations

import pytest

from data_rover.core.script.bridge import BridgeDispatcher
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.facade_src import FACADE_SOURCE
from data_rover.core.script.runner import (
    RunLimits,
    ScriptBudget,
    decode_call_payload,
)
from tests.script.trusted_runner import TrustedRunner


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


# --- Session tests (M2) -----


def _open(model, code: str):
    return TrustedRunner().open_session(
        model, code, RunLimits(), budget=ScriptBudget.start(30)
    )


def test_session_repeated_calls_share_module_state(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "calls = []\ndef value(els):\n    calls.append(1)\n    return len(calls)")
    assert sess.boot_error is None
    r1 = sess.call("value", [ids[0]])
    r2 = sess.call("value", [ids[0]])
    assert r1.value == {"kind": "scalar", "value": 1}
    assert r2.value == {"kind": "scalar", "value": 2}  # module globals persist
    sess.close()


def test_session_boot_error_on_syntax_and_module_exec(small_model) -> None:
    sess_syntax = _open(small_model, "def broken(:")
    assert sess_syntax.boot_error is not None
    assert sess_syntax.boot_error.kind == "syntax"
    sess_runtime = _open(small_model, "raise RuntimeError('boom')")
    assert sess_runtime.boot_error is not None
    assert sess_runtime.boot_error.kind == "runtime"


def test_session_per_call_errors(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "def value(els):\n    return {'not': 'legal'}")
    res = sess.call("value", [ids[0]])
    assert res.error is not None and "value() must return" in res.error.message
    missing = _open(small_model, "x = 1")
    res = missing.call("value", [ids[0]])
    assert res.error is not None and "not defined" in res.error.message


def test_session_is_read_only(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "def value(els):\n    return dr.create('T', {})")
    res = sess.call("value", [ids[0]])
    assert res.error is not None and "ReadOnlyError" in res.error.message


def test_session_step_entry(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, f"def step(el):\n    return ['{ids[0]}']")
    res = sess.call("step", [ids[0]])
    assert res.value == {"ids": [ids[0]]}
    sess.close()


# --- ScriptEvalContext tests (M2+M3) -----


def _ctx(model, **kw) -> ScriptEvalContext:
    return ScriptEvalContext(
        TrustedRunner(), model, RunLimits(), ScriptBudget.start(30), **kw
    )


def test_ctx_memoizes_by_code_entry_ids(small_model) -> None:
    ids = sorted(small_model.elements)
    ctx = _ctx(small_model)
    code = "calls = []\ndef value(els):\n    calls.append(1)\n    return len(calls)"
    r1 = ctx.call(code, "value", [ids[0]])
    r2 = ctx.call(code, "value", [ids[0]])       # memo hit — NOT a second call
    r3 = ctx.call(code, "value", [ids[1]])       # different ids — a real call
    assert r1.value == {"kind": "scalar", "value": 1}
    assert r2.value == {"kind": "scalar", "value": 1}
    assert r3.value == {"kind": "scalar", "value": 2}
    ctx.close()


def test_ctx_unavailable_and_budget(small_model) -> None:
    ids = sorted(small_model.elements)
    ctx = ScriptEvalContext(
        None, None, RunLimits(), ScriptBudget.start(30),
        unavailable_reason="script runner unavailable",
    )
    res = ctx.call("def value(els): return 1", "value", [ids[0]])
    assert res.error is not None and res.error.kind == "unavailable"
    assert ctx.errored

    spent = ScriptEvalContext(
        TrustedRunner(), small_model, RunLimits(), ScriptBudget(deadline=0.0)
    )
    res = spent.call("def value(els): return 1", "value", [ids[0]])
    assert res.error is not None and res.error.kind == "timeout"
    assert "budget" in res.error.message


def test_ctx_boot_error_and_warnings(small_model) -> None:
    ids = sorted(small_model.elements)
    ctx = _ctx(small_model)
    res = ctx.call("raise RuntimeError('boom')", "value", [ids[0]])
    assert res.error is not None and ctx.errored
    ctx.add_warning("w")
    ctx.add_warning("w")  # deduped
    for i in range(30):
        ctx.add_warning(f"w{i}")
    assert ctx.warnings[0] == "w"
    assert len(ctx.warnings) == 20  # capped
    ctx.close()
