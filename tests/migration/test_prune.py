from data_rover.core.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.migration.legacy import prune_inconsistencies


def _mm():
    return Metamodel(
        elements=[ElementType(name="A"), ElementType(name="Base", abstract=True)],
        relationships=[RelationshipType(name="R", source="A", target="A")],
    )


def _el(eid, type_name):
    return {"id": eid, "type_name": type_name, "properties": {}, "rev": 0}


def _rel(rid, type_name, src, tgt):
    return {
        "id": rid,
        "type_name": type_name,
        "source_id": src,
        "target_id": tgt,
        "properties": {},
        "rev": 0,
    }


def test_consistent_model_unchanged():
    model = {
        "rev": 1,
        "elements": [_el("a1", "A"), _el("a2", "A")],
        "relationships": [_rel("r1", "R", "a1", "a2")],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert removed == []
    assert len(cleaned["elements"]) == 2
    assert len(cleaned["relationships"]) == 1


def test_unknown_element_type_removed():
    model = {
        "rev": 1,
        "elements": [_el("a1", "A"), _el("g", "Ghost")],
        "relationships": [],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert {e["id"] for e in cleaned["elements"]} == {"a1"}
    assert any(r.id == "g" and "Ghost" in r.reason for r in removed)


def test_abstract_element_type_removed():
    model = {"rev": 1, "elements": [_el("b", "Base")], "relationships": []}
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert cleaned["elements"] == []
    assert any(r.id == "b" and "abstract" in r.reason.lower() for r in removed)


def test_duplicate_element_id_removed_keeping_first():
    model = {
        "rev": 1,
        "elements": [_el("a1", "A"), _el("a1", "A")],
        "relationships": [],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert len(cleaned["elements"]) == 1
    assert any(r.id == "a1" and "duplicate" in r.reason.lower() for r in removed)


def test_unknown_relationship_type_removed():
    model = {
        "rev": 1,
        "elements": [_el("a1", "A")],
        "relationships": [_rel("r1", "Nope", "a1", "a1")],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert cleaned["relationships"] == []
    assert any(r.id == "r1" and "Nope" in r.reason for r in removed)


def test_dangling_source_removed():
    model = {
        "rev": 1,
        "elements": [_el("a1", "A")],
        "relationships": [_rel("r1", "R", "missing", "a1")],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert cleaned["relationships"] == []
    assert any(r.id == "r1" and "source" in r.reason.lower() for r in removed)


def test_dangling_target_removed():
    model = {
        "rev": 1,
        "elements": [_el("a1", "A")],
        "relationships": [_rel("r1", "R", "a1", "missing")],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert cleaned["relationships"] == []
    assert any(r.id == "r1" and "target" in r.reason.lower() for r in removed)


def test_relationship_to_removed_element_cascades():
    # a2 has an unknown type -> removed; the relationship pointing at it must go too
    model = {
        "rev": 1,
        "elements": [_el("a1", "A"), _el("a2", "Ghost")],
        "relationships": [_rel("r1", "R", "a1", "a2")],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert cleaned["relationships"] == []
    assert {r.id for r in removed} == {"a2", "r1"}


def test_duplicate_relationship_id_removed():
    model = {
        "rev": 1,
        "elements": [_el("a1", "A")],
        "relationships": [_rel("r1", "R", "a1", "a1"), _rel("r1", "R", "a1", "a1")],
    }
    cleaned, removed = prune_inconsistencies(model, _mm())
    assert len(cleaned["relationships"]) == 1
    assert any(r.id == "r1" and "duplicate" in r.reason.lower() for r in removed)
