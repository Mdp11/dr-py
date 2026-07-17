from data_rover.core.script.bridge import BridgeDispatcher, BridgeLimitError

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
