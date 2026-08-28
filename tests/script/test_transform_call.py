"""The transform(doc) session call: arbitrary JSON in, arbitrary
JSON out, through the same _dr_call_entry driver value/step use. Exercised
against TrustedRunner; the WASM frame has its own integration test."""

import pytest

from data_rover.core.script.runner import RunLimits, ScriptBudget, decode_call_payload
from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner

# Reuse this package's existing model-building helper from conftest/test_session
# for the session's model argument (the transform tests never read the model,
# so the smallest fixture the package offers is fine).


@pytest.fixture
def model():
    return tiny_model()


def _session(model, code):
    return TrustedRunner().open_session(
        model, code, RunLimits(), budget=ScriptBudget.start(30)
    )


def test_transform_receives_and_returns_json(model):
    s = _session(model, "def transform(doc):\n    return {'wrapped': doc, 'n': len(doc)}\n")
    assert s.boot_error is None
    r = s.call("transform", [], doc=[{"a": 1}, {"a": 2}])
    assert r.error is None
    assert r.value == {"kind": "json", "value": {"wrapped": [{"a": 1}, {"a": 2}], "n": 2}}


def test_transform_may_read_the_model(model):
    # The facade is unchanged: dr.* reads work inside transform().
    s = _session(model, "def transform(doc):\n    return len(list(dr.elements()))\n")
    r = s.call("transform", [], doc=None)
    assert r.error is None
    assert r.value is not None and r.value["kind"] == "json"


def test_transform_raise_is_a_runtime_error(model):
    s = _session(model, "def transform(doc):\n    raise RuntimeError('boom')\n")
    r = s.call("transform", [], doc={})
    assert r.error is not None and r.error.kind == "runtime"
    assert "boom" in r.error.message


def test_transform_unserializable_return_is_an_error(model):
    s = _session(model, "def transform(doc):\n    return object()\n")
    r = s.call("transform", [], doc={})
    assert r.error is not None and "JSON" in r.error.message


def test_missing_transform_entry_is_an_error(model):
    s = _session(model, "def value(elements):\n    return 1\n")
    r = s.call("transform", [], doc={})
    assert r.error is not None and "not defined" in r.error.message


def test_decode_rejects_json_tag_for_value_entry():
    decoded, msg = decode_call_payload("value", {"kind": "json", "value": 1})
    assert decoded is None and msg is not None


def test_decode_transform_accepts_any_json_value():
    for v in (None, 0, "x", [1, {"a": None}], {"k": [True]}):
        decoded, msg = decode_call_payload("transform", {"kind": "json", "value": v})
        assert msg is None and decoded == {"kind": "json", "value": v}
    decoded, msg = decode_call_payload("transform", {"nodes": []})
    assert decoded is None


def test_call_stdout_is_per_call_and_carries_boot_prints_once(model):
    # Module-level prints are captured at boot and ride on the FIRST call's
    # stdout only; every later call reports just its own prints.
    s = _session(
        model,
        "print('booting')\n"
        "def transform(doc):\n    print('seen', doc)\n    return doc\n",
    )
    first = s.call("transform", [], doc=1)
    assert first.error is None
    assert first.stdout == "booting\nseen 1\n"
    second = s.call("transform", [], doc=2)
    assert second.stdout == "seen 2\n"


def test_call_stdout_survives_a_raise(model):
    s = _session(model, "def transform(doc):\n    print('before')\n    raise ValueError('x')\n")
    r = s.call("transform", [], doc={})
    assert r.error is not None and r.error.kind == "runtime"
    assert r.stdout == "before\n"
