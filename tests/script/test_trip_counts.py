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


def test_element_refetch_is_memoized(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    a = dr.element('b2')\n"
        "    b = dr.element('b2')\n"
        "    return a.name + b.name\n"
    )
    assert sess.call("value", ["b1"]).error is None
    assert bridge_call_log.count("element") == 2  # b1 root + b2 once


def test_memo_survives_across_calls(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return dr.element('b2').name\n")
    assert sess.call("value", ["b1"]).error is None
    assert sess.call("value", ["b3"]).error is None
    # b2 fetched once across BOTH calls (session-lifetime memo)
    assert bridge_call_log.count("element") == 3  # b1, b2, b3


def test_adjacency_reads_are_memoized(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    els[0].out(); els[0].out()\n"
        "    els[0].children(); els[0].children()\n"
        "    els[0].parent(); els[0].parent()\n"
        "    dr.types(); dr.types()\n"
        "    return 1\n"
    )
    assert sess.call("value", ["b2"]).error is None
    for op in ("outgoing", "children", "parent", "types"):
        assert bridge_call_log.count(op) == 1, op


def test_memo_cap_evicts_oldest(bridge_call_log: list[str]) -> None:
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n"
        "    dr.element('b2'); dr.element('b3')\n"
        "    dr.element('b2')\n"  # b2 was evicted by b3 under cap=1
        "    return 1\n",
        RunLimits(read_memo_max=1),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    assert sess.call("value", ["b1"]).error is None
    assert bridge_call_log.count("element") == 4  # b1, b2, b3, b2-again


def test_memoized_results_do_not_alias_mutations(bridge_call_log: list[str]) -> None:
    """A snippet mutating a returned relationships list must not poison later
    reads of the same memo entry — the facade hands out shallow copies."""
    sess = _open(
        "def value(els):\n"
        "    rels = els[0].out()\n"
        "    rels.append('junk')\n"
        "    return len(els[0].out())\n"
    )
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert res.value == {"kind": "scalar", "value": 1}
