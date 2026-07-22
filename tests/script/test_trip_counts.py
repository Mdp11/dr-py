"""Bridge round-trip counting tests for the trip-collapse work (Phase A').

Every test asserts on `bridge_call_log` — the number of
`BridgeDispatcher.dispatch` calls IS the host round-trip count. Tests use
`TrustedRunner` sessions so they are hermetic; the wire shapes are identical
to the WASM path by construction (same FACADE_SOURCE, same dispatcher).
"""

from __future__ import annotations

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
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
    sess = _open("def value(els):\n    return dr.element('b2').name\n")
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert bridge_call_log.count("element") == 1  # b2; the b1 root rode the call frame


def test_element_refetch_is_memoized(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    a = dr.element('b2')\n"
        "    b = dr.element('b2')\n"
        "    return a.name + b.name\n"
    )
    assert sess.call("value", ["b1"]).error is None
    assert bridge_call_log.count("element") == 1  # b2 once; b1 root piggybacked


def test_memo_survives_across_calls(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return dr.element('b2').name\n")
    assert sess.call("value", ["b1"]).error is None
    assert sess.call("value", ["b3"]).error is None
    # b2 fetched once across BOTH calls (session-lifetime memo)
    assert bridge_call_log.count("element") == 1  # b2 once; b1/b3 roots piggybacked


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


def test_memo_cap_admits_multiple_and_evicts_fifo(bridge_call_log: list[str]) -> None:
    """cap=1 can't distinguish real FIFO eviction from a broken/no-op memo:
    the b2-refetch would cost a round trip either way, so that cap can't
    prove the memo evicts (as opposed to caching nothing at all, or capping
    at 0). Use cap=2 instead: after `element('b1')` (the bound root) and
    `element('b2')`, the memo holds {b1, b2} (2 entries, at cap). Fetching
    b3 must evict the OLDEST entry (b1) to admit b3, leaving {b2, b3} — so
    the re-fetch of b2 is a memo HIT (no round trip). This proves both that
    the cap admits more than one entry AND that eviction order is
    FIFO-from-the-front (insertion order): a broken/no-op memo, a cap that
    silently clamped to 0 or 1, or an eviction policy that pops the NEWEST
    entry instead would all leave b2 evicted too, making the b2-refetch a
    round trip and the total 4 instead of 3.
    """
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n"
        "    dr.element('b2')\n"
        "    dr.element('b3')\n"  # cap=2 full at {b1, b2}; b3 evicts b1 (FIFO)
        "    dr.element('b2')\n"  # b2 still resident -> memo HIT, no round trip
        "    return 1\n",
        RunLimits(read_memo_max=2),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    assert sess.call("value", ["b1"]).error is None
    # b1 root rides the call frame (primed, no round trip, but still occupies
    # a FIFO slot); b2 and b3 each cost one round trip; b2-again is a memo hit.
    assert bridge_call_log.count("element") == 2  # b2, b3


def test_memoized_results_do_not_alias_mutations(bridge_call_log: list[str]) -> None:
    """A snippet mutating a returned relationships list must not poison later
    reads of the same memo entry — the facade hands out copies (containers
    and list-valued properties included; see `_copy_projection`)."""
    sess = _open(
        "def value(els):\n"
        "    rels = els[0].out()\n"
        "    rels.append('junk')\n"
        "    return len(els[0].out())\n"
    )
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert res.value == {"kind": "scalar", "value": 1}


def test_memoized_element_does_not_alias_list_valued_property(
    bridge_call_log: list[str],
) -> None:
    """A snippet mutating a LIST-VALUED PROPERTY in place on a memoized
    element projection must not poison a later fetch of the same element in
    the same session.

    Multi-valued properties are first-class (see
    `validation/validators/multiplicity.py` and `type_conformance.py`), so a
    projection's `properties` dict can map a key to a `list`. A shallow
    `dict(...)` copy of the projection copies the outer dict, but the
    `properties` dict AND its list values are still the memo's own objects
    -- `el["tags"].append(...)` would reach back into `_memo` and change
    what a later `dr.element(same_id)` call returns. Only `_copy_projection`
    (which deep-copies `properties` and any list values inside it) closes
    that hole; this test exercises it through the public `dr`/`Element` API
    only (no `_data` access).
    """
    del bridge_call_log  # unused; this test asserts on returned VALUES, not trip counts
    mm = Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                ],
            ),
        ],
    )
    model = Model(mm)
    b1 = model.restore_element("b1", "Building")
    model.set_property(b1, "name", "Building One")
    model.set_property(b1, "tags", ["a", "b"])

    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n"
        "    first = dr.element('b1')\n"
        "    first['tags'].append('junk')\n"
        "    second = dr.element('b1')\n"
        "    return len(second['tags'])\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None, sess.boot_error
    res = sess.call("value", ["b1"])
    assert res.error is None
    # The memo entry must still hold the original 2 tags -- the mutation on
    # `first` must not have leaked into the memo for `second` to observe.
    assert res.value == {"kind": "scalar", "value": 2}


def test_hop_primes_neighbor_projections(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    total = 0\n"
        "    for rel in els[0].out():\n"
        "        total += len(dr.element(rel['target_id']).name)\n"
        "    return total\n"
    )
    assert sess.call("value", ["b1"]).error is None
    # b1 root piggybacked (no fetch); one outgoing hop; the b2 neighbor fetch
    # is served from the projections the hop response shipped.
    assert bridge_call_log.count("element") == 0  # root piggybacked, neighbor rode the hop
    assert bridge_call_log.count("outgoing") == 1


def test_incoming_primes_source_projections(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    rels = els[0].in_()\n"
        "    return dr.element(rels[0]['source_id']).name\n"
    )
    assert sess.call("value", ["b2"]).error is None
    assert bridge_call_log.count("element") == 0  # b2 root piggybacked; b1 rode the hop


def test_hop_falls_back_to_per_neighbor_fetch_when_inline_guard_trips(
    bridge_call_log: list[str], monkeypatch
) -> None:
    """`bridge._far_endpoints`'s high-degree guard (tested directly in
    `tests/script/test_bridge.py`) ships `resp["elements"] == []` once
    tripped. The facade's `out()` already tolerates that via `resp.get(
    "elements") or []` -- this proves the DEGRADED path still produces the
    SAME correct result as the fast path (`test_hop_primes_neighbor_
    projections` above), just via one round trip per dereferenced neighbor
    instead of zero, so the optimization never changes what a snippet
    observes, only how many bridge round trips it costs."""
    from data_rover.core.script import bridge as bridge_module

    monkeypatch.setattr(bridge_module, "_MAX_INLINE_FAR_ENDPOINTS", 0)
    sess = _open(
        "def value(els):\n"
        "    total = 0\n"
        "    for rel in els[0].out():\n"
        "        total += len(dr.element(rel['target_id']).name)\n"
        "    return total\n"
    )
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert res.value == {"kind": "scalar", "value": len("Building Two")}
    # guard tripped -> the b2 neighbor fetch costs its own round trip, unlike
    # the fast path's 0 (b1 root piggybacked, b2 rides the hop)
    assert bridge_call_log.count("element") == 1  # b2 neighbor; b1 root piggybacked
    assert bridge_call_log.count("outgoing") == 1


def test_root_piggyback_zero_trips_for_property_math(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return els[0].name\n")
    assert sess.call("value", ["b1"]).error is None
    assert sess.call("value", ["b2"]).error is None
    assert bridge_call_log == []  # roots ship with the call frame


def test_missing_root_still_raises_not_found(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return els[0].name\n")
    res = sess.call("value", ["nope"])
    assert res.error is not None
    assert res.error.kind == "runtime"
    assert "NotFoundError" in res.error.message
    assert bridge_call_log.count("element") == 1  # guest fell back to a fetch


def test_step_entry_gets_piggybacked_root(bridge_call_log: list[str]) -> None:
    sess = _open("def step(el):\n    return [el]\n")
    res = sess.call("step", ["b1"])
    assert res.error is None
    assert res.value == {"ids": ["b1"]}
    assert bridge_call_log == []


def test_read_memo_max_zero_changes_trips_never_results(
    bridge_call_log: list[str],
) -> None:
    """`read_memo_max <= 0` skips host-side root projection (the `call()`
    guard documented in `trusted_runner.py`/`api/script_runner.py`, right
    beside `_memo_put`'s no-op-on-non-positive-cap behavior). The point of
    this test is that the guard is a pure trip-count optimization: it must
    NEVER change what a snippet computes, only whether the root rides the
    call frame for free or costs a fetch.

    Baseline (default `RunLimits`, memo enabled): the root piggybacks on the
    call frame for zero round trips -- see
    `test_root_piggyback_zero_trips_for_property_math` above, same snippet.
    With `read_memo_max=0`: the guard skips that projection (it would be
    wasted work -- a disabled memo can't retain it), so the guest's first
    access to the root falls back to an explicit `element` fetch, exactly
    like the cache-miss path in `test_missing_root_still_raises_not_found`.
    """
    code = "def value(els):\n    return els[0].name\n"
    model = tiny_model()

    baseline = TrustedRunner().open_session(
        model, code, RunLimits(), budget=ScriptBudget.start(60)
    )
    assert baseline.boot_error is None, baseline.boot_error
    baseline_res = baseline.call("value", ["b1"])
    assert baseline_res.error is None
    assert bridge_call_log.count("element") == 0  # root piggybacked, no fetch
    bridge_call_log.clear()

    unmemoized = TrustedRunner().open_session(
        model, code, RunLimits(read_memo_max=0), budget=ScriptBudget.start(60)
    )
    assert unmemoized.boot_error is None, unmemoized.boot_error
    unmemoized_res = unmemoized.call("value", ["b1"])
    assert unmemoized_res.error is None

    # Same result either way -- the guard only ever changes trip counts.
    assert unmemoized_res.value == baseline_res.value
    # But the root projection was skipped, so the guest had to fetch it.
    assert bridge_call_log.count("element") == 1
