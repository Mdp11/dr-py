"""Bridge round-trip counting tests for the trip-collapse work (Phase A').

Every test asserts on `bridge_call_log` — the number of
`BridgeDispatcher.dispatch` calls IS the host round-trip count. Tests use
`TrustedRunner` sessions so they are hermetic; the wire shapes are identical
to the WASM path by construction (same FACADE_SOURCE, same dispatcher).
"""

from __future__ import annotations

from data_rover.core.script.runner import RunLimits, ScriptBudget

from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner


def _open(code: str):
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model, code, RunLimits(), budget=ScriptBudget.start(60)
    )
    assert sess.boot_error is None, sess.boot_error
    return sess


def test_fixture_counts_dispatch_calls(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return els[0].name\n")
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert bridge_call_log.count("element") >= 1
