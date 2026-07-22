import json

from data_rover.core.script.bridge import (
    BridgeDispatcher,
    BridgeLimitError,
    project_element,
    project_roots,
)

from tests.script.conftest import tiny_model


def _model():
    # Build a tiny in-memory model via the real Model API.
    return tiny_model()


def test_element_read():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "element", "element_id": "b1"})
    assert resp["id"] == 1 and resp["element"]["id"] == "b1"


def test_elements_page():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 2, "op": "elements_page", "type": None, "offset": 0, "limit": 500})
    assert isinstance(resp["elements"], list) and "next_offset" in resp


def test_record_op_blocked_when_read_only():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 3, "op": "record_op",
                          "op": {"kind": "delete_element", "id": "b1"}})
    assert "error" in resp and "ReadOnly" in resp["error"]
    assert disp.ops == []


def test_record_op_accumulates():
    disp = BridgeDispatcher(_model(), record_ops=True)
    disp.dispatch({"id": 4, "op": "record_op",
                   "op": {"kind": "delete_element", "id": "b1"}})
    assert disp.ops == [{"kind": "delete_element", "id": "b1"}]


def test_ops_cap_enforced():
    disp = BridgeDispatcher(_model(), record_ops=True, max_ops=2)
    disp.dispatch({"id": 1, "op": "record_op", "op": {"kind": "delete_element", "id": "b1"}})
    disp.dispatch({"id": 2, "op": "record_op", "op": {"kind": "delete_element", "id": "b2"}})
    resp = disp.dispatch({"id": 3, "op": "record_op", "op": {"kind": "delete_element", "id": "b3"}})
    assert "error" in resp and "cap" in resp["error"].lower()


# --- additional coverage: read ops not exercised by the brief's tests ------


def test_element_read_missing_returns_error():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "element", "element_id": "nope"})
    assert resp["id"] == 1
    assert "error" in resp and "KeyError" in resp["error"]


def test_elements_page_filters_by_type_and_pages():
    disp = BridgeDispatcher(_model(), record_ops=False, page_limit=2)
    resp = disp.dispatch(
        {"id": 1, "op": "elements_page", "type": "Building", "offset": 0, "limit": 500}
    )
    # page_limit clamps the oversized limit request to 2 elements per page.
    assert [e["id"] for e in resp["elements"]] == ["b1", "b2"]
    assert resp["next_offset"] == 2

    resp2 = disp.dispatch(
        {"id": 2, "op": "elements_page", "type": "Building", "offset": 2, "limit": 500}
    )
    assert [e["id"] for e in resp2["elements"]] == ["b3"]
    assert resp2["next_offset"] is None


def test_outgoing_returns_relationships_from_element():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "outgoing", "element_id": "b1"})
    rels = resp["relationships"]
    assert len(rels) == 1
    assert rels[0]["type"] == "Owns"
    assert rels[0]["source_id"] == "b1" and rels[0]["target_id"] == "b2"


def test_incoming_returns_relationships_to_element():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "incoming", "element_id": "b2"})
    rels = resp["relationships"]
    assert len(rels) == 1
    assert rels[0]["type"] == "Owns"
    assert rels[0]["source_id"] == "b1" and rels[0]["target_id"] == "b2"


def test_parent_of_owned_element():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "parent", "element_id": "b2"})
    assert resp["parent_id"] == "b1"


def test_parent_of_root_element_is_none():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "parent", "element_id": "b1"})
    assert resp["parent_id"] is None


def test_children_of_owner():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "children", "element_id": "b1"})
    assert [c["id"] for c in resp["children"]] == ["b2"]


def test_children_of_childless_element_is_empty():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "children", "element_id": "b3"})
    assert resp["children"] == []


def test_types_lists_element_type_names():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "types"})
    assert resp["types"] == ["Building"]


def test_type_info_returns_effective_properties():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "type_info", "type": "Building"})
    assert resp["type"] == "Building"
    names = {p["name"] for p in resp["properties"]}
    assert "name" in names


def test_type_info_unknown_type_returns_error():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "type_info", "type": "Ghost"})
    assert "error" in resp and "KeyError" in resp["error"]


def test_unknown_op_returns_error():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "not_a_real_op"})
    assert resp["id"] == 1
    assert "error" in resp


def test_bridge_limit_error_is_an_exception():
    assert issubclass(BridgeLimitError, Exception)


# --- malformed params must not raise past dispatch() (untrusted guest) -----


def test_element_with_unhashable_id_returns_error_not_raise():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "element", "element_id": ["x"]})
    assert resp["id"] == 1
    assert "error" in resp


def test_elements_page_with_non_int_offset_returns_error_not_raise():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch(
        {"id": 1, "op": "elements_page", "offset": [1, 2], "limit": 5}
    )
    assert resp["id"] == 1
    assert "error" in resp


def test_type_info_with_unhashable_type_returns_error_not_raise():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "type_info", "type": ["x"]})
    assert resp["id"] == 1
    assert "error" in resp


def test_dispatch_with_missing_id_still_returns_a_response():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"op": "not_a_real_op"})
    assert resp["id"] is None
    assert "error" in resp


# --- far-endpoint inlining (trip-collapse, spec 2026-07-21 Phase A') -------


def test_outgoing_response_inlines_far_endpoints():
    d = BridgeDispatcher(_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "outgoing", "element_id": "b1"})
    assert [e["id"] for e in resp["elements"]] == ["b2"]
    assert resp["elements"][0]["name"] == "Building Two"


def test_incoming_response_inlines_far_endpoints():
    d = BridgeDispatcher(_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "incoming", "element_id": "b2"})
    assert [e["id"] for e in resp["elements"]] == ["b1"]


def test_far_endpoints_skips_inlining_above_the_high_degree_guard(monkeypatch):
    """A hub whose distinct-endpoint count exceeds `_MAX_INLINE_FAR_ENDPOINTS`
    must get `resp["elements"] == []` (guard tripped, no projection work
    done) while `resp["relationships"]` stays complete -- the read itself is
    never degraded, only the inline fast path is skipped. Monkeypatch the
    module constant down to 2 rather than building 2048+ real elements: the
    guard only cares about the count, not what the number IS.
    """
    from data_rover.core.script import bridge as bridge_module

    monkeypatch.setattr(bridge_module, "_MAX_INLINE_FAR_ENDPOINTS", 2)

    model = tiny_model()
    hub = model.restore_element("hub", "Building")
    model.set_property(hub, "name", "Hub")
    targets = []
    for i in range(3):  # 3 distinct endpoints > guard of 2
        tid = f"t{i}"
        targets.append(tid)
        el = model.restore_element(tid, "Building")
        model.set_property(el, "name", f"Target {i}")
        model.connect("Owns", "hub", tid)

    d = BridgeDispatcher(model, record_ops=False)
    resp = d.dispatch({"id": 1, "op": "outgoing", "element_id": "hub"})
    assert resp["elements"] == []
    assert sorted(r["target_id"] for r in resp["relationships"]) == sorted(targets)


def test_far_endpoints_dedup_happens_before_the_guard_check(monkeypatch):
    """The guard compares against the DISTINCT endpoint count, not the raw
    relationship count -- a hub with many parallel edges to the SAME
    neighbor must not trip the guard just because it has many edges."""
    from data_rover.core.script import bridge as bridge_module

    monkeypatch.setattr(bridge_module, "_MAX_INLINE_FAR_ENDPOINTS", 2)

    model = tiny_model()
    hub = model.restore_element("hub", "Building")
    model.set_property(hub, "name", "Hub")
    # 3 parallel edges, but only ONE distinct target -- must stay under the
    # guard of 2 distinct endpoints and still inline.
    for _ in range(3):
        model.connect("Owns", "hub", "b1")

    d = BridgeDispatcher(model, record_ops=False)
    resp = d.dispatch({"id": 1, "op": "outgoing", "element_id": "hub"})
    assert [e["id"] for e in resp["elements"]] == ["b1"]
    assert len(resp["relationships"]) == 3


# --- max_op_bytes cap (distinct code path from the max_ops count cap) ------


def test_record_op_byte_cap_enforced():
    small_op = {"kind": "delete_element", "id": "b1"}
    # first op's serialized size, so the SECOND identical op is guaranteed to
    # push cumulative usage over the cap (max_op_bytes counts cumulatively,
    # not per-op).
    cap = len(json.dumps(small_op))
    disp = BridgeDispatcher(_model(), record_ops=True, max_op_bytes=cap)

    ok = disp.dispatch({"id": 1, "op": "record_op", "op": small_op})
    assert "error" not in ok
    assert disp.ops == [small_op]

    resp = disp.dispatch(
        {"id": 2, "op": "record_op", "op": {"kind": "delete_element", "id": "b2"}}
    )
    assert "error" in resp and "cap" in resp["error"].lower()
    # the rejected op must not have been appended
    assert disp.ops == [small_op]


# --- project_roots (shared host-side root piggyback helper) ---------------


def test_project_roots_omits_missing_id_rather_than_placeholder():
    """A missing id must be OMITTED, never encoded as a `None`/placeholder
    entry -- the guest keys priming off `proj["id"]`, not position, so a
    placeholder would either crash the guest's priming loop or silently
    prime a fake entry. See `project_roots`'s docstring for the full
    contract this protects."""
    model = tiny_model()
    result = project_roots(model, ["b1", "nope", "b2"])
    assert [proj["id"] for proj in result] == ["b1", "b2"]
    assert all(proj is not None for proj in result)


def test_project_roots_preserves_input_order():
    model = tiny_model()
    # Deliberately out-of-natural-order and with a repeat -- the surviving
    # projections must follow the INPUT order, not model insertion order.
    result = project_roots(model, ["b3", "b1", "b3", "b2"])
    assert [proj["id"] for proj in result] == ["b3", "b1", "b3", "b2"]


def test_project_roots_projection_matches_project_element_shape():
    model = _model()
    result = project_roots(model, ["b1"])
    assert result == [project_element(model.get_element("b1"))]


def test_project_roots_empty_input_returns_empty_list():
    model = tiny_model()
    assert project_roots(model, []) == []
