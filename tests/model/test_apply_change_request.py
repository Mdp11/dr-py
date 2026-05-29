from __future__ import annotations

from dataclasses import asdict

import pytest

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.change_request import (
    ChangeRequest,
    CRConflict,
    CRConflictError,
    ModifiedElement,
    ModifiedRelationship,
    apply_change_request,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[PropertyDef(name="name", datatype="string")],
            )
        ],
        relationships=[RelationshipType(name="Link", source="Block", target="Block")],
    )


def _empty_cr() -> ChangeRequest:
    return ChangeRequest([], [], [], [], [], [])


def _model_with_block(eid: str = "e1", name: str = "A") -> Model:
    model = Model(_mm())
    model.elements[eid] = Element(id=eid, type_name="Block", properties={"name": name})
    return model


# ---------------------------------------------------------------------------
# 1. Types construct correctly
# ---------------------------------------------------------------------------


def test_cr_conflict_asdict():
    c = CRConflict(kind="id_exists", entity="element", id="x", reason="already there")
    d = asdict(c)
    assert d == {
        "kind": "id_exists",
        "entity": "element",
        "id": "x",
        "reason": "already there",
    }


def test_cr_conflict_error_stores_conflicts():
    c = CRConflict(kind="missing", entity="relationship", id="r1", reason="gone")
    err = CRConflictError([c])
    assert err.conflicts == [c]
    assert "1" in str(err)


def test_change_request_default_fields():
    cr = ChangeRequest()
    assert cr.elements_added == []
    assert cr.elements_modified == []
    assert cr.elements_deleted == []
    assert cr.relationships_added == []
    assert cr.relationships_modified == []
    assert cr.relationships_deleted == []


# ---------------------------------------------------------------------------
# 2. id_exists conflict — element
# ---------------------------------------------------------------------------


def test_id_exists_element():
    model = _model_with_block("e1")
    new_e = Element(id="e1", type_name="Block", properties={"name": "B"})
    cr = ChangeRequest(elements_added=[new_e])
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "id_exists"
    assert conflicts[0].entity == "element"
    assert conflicts[0].id == "e1"


# ---------------------------------------------------------------------------
# 3. id_exists conflict — relationship
# ---------------------------------------------------------------------------


def test_id_exists_relationship():
    model = _model_with_block("e1")
    model.elements["e2"] = Element(id="e2", type_name="Block", properties={})
    model.relationships["r1"] = Relationship(
        id="r1", type_name="Link", source_id="e1", target_id="e2"
    )
    dup_rel = Relationship(id="r1", type_name="Link", source_id="e2", target_id="e1")
    cr = ChangeRequest(relationships_added=[dup_rel])
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "id_exists"
    assert conflicts[0].entity == "relationship"
    assert conflicts[0].id == "r1"


# ---------------------------------------------------------------------------
# 4. missing conflict — modified element
# ---------------------------------------------------------------------------


def test_missing_modified_element():
    model = Model(_mm())  # empty
    before = Element(id="ghost", type_name="Block", properties={"name": "X"})
    after = Element(id="ghost", type_name="Block", properties={"name": "Y"})
    cr = ChangeRequest(elements_modified=[ModifiedElement(id="ghost", before=before, after=after)])
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "missing"
    assert conflicts[0].entity == "element"
    assert conflicts[0].id == "ghost"


# ---------------------------------------------------------------------------
# 5. missing conflict — deleted element
# ---------------------------------------------------------------------------


def test_missing_deleted_element():
    model = Model(_mm())
    ghost = Element(id="ghost", type_name="Block", properties={})
    cr = ChangeRequest(elements_deleted=[ghost])
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "missing"
    assert conflicts[0].entity == "element"
    assert conflicts[0].id == "ghost"


# ---------------------------------------------------------------------------
# 6. before_mismatch conflict — modified element
# ---------------------------------------------------------------------------


def test_before_mismatch_modified_element():
    model = _model_with_block("e1", "A")
    wrong_before = Element(id="e1", type_name="Block", properties={"name": "WRONG"})
    after = Element(id="e1", type_name="Block", properties={"name": "B"})
    cr = ChangeRequest(
        elements_modified=[ModifiedElement(id="e1", before=wrong_before, after=after)]
    )
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "before_mismatch"
    assert conflicts[0].entity == "element"
    assert conflicts[0].id == "e1"


# ---------------------------------------------------------------------------
# 7. rev is ignored for match — content matches but rev differs → no conflict
# ---------------------------------------------------------------------------


def test_rev_ignored_for_match():
    model = _model_with_block("e1", "A")
    model.elements["e1"].rev = 5  # artificially bump rev

    # CR before has rev=0, which differs from current rev=5, but content matches
    before = Element(id="e1", type_name="Block", properties={"name": "A"}, rev=0)
    after = Element(id="e1", type_name="Block", properties={"name": "B"}, rev=0)
    cr = ChangeRequest(elements_modified=[ModifiedElement(id="e1", before=before, after=after)])
    result = apply_change_request(model, cr)
    # Should succeed — no conflict raised
    assert result.elements["e1"].properties["name"] == "B"


# ---------------------------------------------------------------------------
# 8. abort-all: two conflicts collected, input model untouched
# ---------------------------------------------------------------------------


def test_abort_all_multiple_conflicts():
    model = _model_with_block("e1", "A")
    # conflict 1: id_exists for added element "e1"
    dup = Element(id="e1", type_name="Block", properties={"name": "X"})
    # conflict 2: missing for modified element "ghost"
    before_ghost = Element(id="ghost", type_name="Block", properties={})
    after_ghost = Element(id="ghost", type_name="Block", properties={"name": "Y"})
    cr = ChangeRequest(
        elements_added=[dup],
        elements_modified=[ModifiedElement(id="ghost", before=before_ghost, after=after_ghost)],
    )
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    assert len(exc_info.value.conflicts) == 2
    # Input model is unchanged
    assert "e1" in model.elements
    assert model.elements["e1"].properties["name"] == "A"
    assert len(model.elements) == 1


# ---------------------------------------------------------------------------
# 9. Clean apply — add + modify + delete on elements; input model unchanged
# ---------------------------------------------------------------------------


def test_clean_apply_add_modify_delete_elements():
    model = Model(_mm())
    model.elements["keep"] = Element(id="keep", type_name="Block", properties={"name": "Keep"})
    model.elements["mod"] = Element(id="mod", type_name="Block", properties={"name": "Old"})
    model.elements["del"] = Element(id="del", type_name="Block", properties={"name": "Del"})

    new_e = Element(id="new", type_name="Block", properties={"name": "New"})
    before_mod = Element(id="mod", type_name="Block", properties={"name": "Old"})
    after_mod = Element(id="mod", type_name="Block", properties={"name": "New"})
    del_snap = Element(id="del", type_name="Block", properties={"name": "Del"})

    cr = ChangeRequest(
        elements_added=[new_e],
        elements_modified=[ModifiedElement(id="mod", before=before_mod, after=after_mod)],
        elements_deleted=[del_snap],
    )
    result = apply_change_request(model, cr)

    # Result is correct
    assert set(result.elements.keys()) == {"keep", "mod", "new"}
    assert result.elements["new"].properties["name"] == "New"
    assert result.elements["mod"].properties["name"] == "New"
    assert "del" not in result.elements
    assert result.elements["keep"].properties["name"] == "Keep"

    # Input model is untouched
    assert set(model.elements.keys()) == {"keep", "mod", "del"}
    assert model.elements["mod"].properties["name"] == "Old"


# ---------------------------------------------------------------------------
# 10. Modify bumps rev by exactly 1
# ---------------------------------------------------------------------------


def test_modify_bumps_rev():
    model = _model_with_block("e1", "A")
    model.elements["e1"].rev = 3

    before = Element(id="e1", type_name="Block", properties={"name": "A"}, rev=3)
    after = Element(id="e1", type_name="Block", properties={"name": "B"}, rev=3)
    cr = ChangeRequest(elements_modified=[ModifiedElement(id="e1", before=before, after=after)])
    result = apply_change_request(model, cr)
    assert result.elements["e1"].rev == 4  # 3 + 1


# ---------------------------------------------------------------------------
# 11. Relationship add — source_id / target_id preserved
# ---------------------------------------------------------------------------


def test_relationship_add_round_trips():
    model = Model(_mm())
    model.elements["a"] = Element(id="a", type_name="Block", properties={})
    model.elements["b"] = Element(id="b", type_name="Block", properties={})

    rel = Relationship(id="r1", type_name="Link", source_id="a", target_id="b")
    cr = ChangeRequest(relationships_added=[rel])
    result = apply_change_request(model, cr)

    assert "r1" in result.relationships
    r = result.relationships["r1"]
    assert r.source_id == "a"
    assert r.target_id == "b"
    assert r.type_name == "Link"
    # Input model unchanged
    assert "r1" not in model.relationships


# ---------------------------------------------------------------------------
# 12. before_mismatch for deleted element (snapshot mismatch)
# ---------------------------------------------------------------------------


def test_before_mismatch_deleted_element():
    model = _model_with_block("e1", "A")
    wrong_snap = Element(id="e1", type_name="Block", properties={"name": "WRONG"})
    cr = ChangeRequest(elements_deleted=[wrong_snap])
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "before_mismatch"
    assert conflicts[0].entity == "element"


# ---------------------------------------------------------------------------
# 13. missing + before_mismatch for relationships
# ---------------------------------------------------------------------------


def test_missing_modified_relationship():
    model = Model(_mm())
    before_r = Relationship(id="r99", type_name="Link", source_id="a", target_id="b")
    after_r = Relationship(id="r99", type_name="Link", source_id="a", target_id="b")
    cr = ChangeRequest(
        relationships_modified=[ModifiedRelationship(id="r99", before=before_r, after=after_r)]
    )
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "missing"
    assert conflicts[0].entity == "relationship"


def test_before_mismatch_modified_relationship():
    model = Model(_mm())
    model.elements["a"] = Element(id="a", type_name="Block", properties={})
    model.elements["b"] = Element(id="b", type_name="Block", properties={})
    model.elements["c"] = Element(id="c", type_name="Block", properties={})
    model.relationships["r1"] = Relationship(
        id="r1", type_name="Link", source_id="a", target_id="b"
    )
    # before claims source_id="a", target_id="c" — doesn't match current
    wrong_before = Relationship(id="r1", type_name="Link", source_id="a", target_id="c")
    after_r = Relationship(id="r1", type_name="Link", source_id="a", target_id="b")
    cr = ChangeRequest(
        relationships_modified=[ModifiedRelationship(id="r1", before=wrong_before, after=after_r)]
    )
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "before_mismatch"
    assert conflicts[0].entity == "relationship"


# ---------------------------------------------------------------------------
# 14. Deep isolation — mutating result entities must not affect input model or CR
# ---------------------------------------------------------------------------


def test_result_entities_are_deep_isolated_from_model_and_cr():
    """Mutating properties on result entities must not affect the original model
    elements or the CR's added elements (purity guarantee)."""
    model = Model(_mm())
    # Carried-over element (will be unchanged in the CR)
    model.elements["existing"] = Element(
        id="existing", type_name="Block", properties={"name": "Original"}
    )

    # CR adds a brand-new element
    added_elem = Element(id="new", type_name="Block", properties={"name": "Added"})
    cr = ChangeRequest(elements_added=[added_elem])

    result = apply_change_request(model, cr)

    # Mutate both entities in the result
    result.elements["existing"].properties["name"] = "MUTATED"
    result.elements["new"].properties["name"] = "MUTATED"

    # The input model's element must be unchanged
    assert model.elements["existing"].properties["name"] == "Original"

    # The CR's added element must be unchanged
    assert added_elem.properties["name"] == "Added"


# ---------------------------------------------------------------------------
# Fix 1 regression — canonical id when after.id differs from op.id
# ---------------------------------------------------------------------------


def test_modified_element_uses_op_id_not_after_id():
    """When after.id differs from op.id, result entity must use op.id."""
    model = _model_with_block("e1", "A")
    before = Element(id="e1", type_name="Block", properties={"name": "A"})
    # after.id is intentionally different from the op id "e1"
    after = Element(id="DIFFERENT", type_name="Block", properties={"name": "B"})
    cr = ChangeRequest(
        elements_modified=[ModifiedElement(id="e1", before=before, after=after)]
    )
    result = apply_change_request(model, cr)

    # The entity must be stored under the canonical op id
    assert "e1" in result.elements
    assert "DIFFERENT" not in result.elements
    # And the entity's own .id field must also be the canonical id
    assert result.elements["e1"].id == "e1"
    # Properties come from after
    assert result.elements["e1"].properties["name"] == "B"


def test_modified_relationship_uses_op_id_not_after_id():
    """When after.id differs from op.id, result relationship must use op.id."""
    model = Model(_mm())
    model.elements["a"] = Element(id="a", type_name="Block", properties={})
    model.elements["b"] = Element(id="b", type_name="Block", properties={})
    model.relationships["r1"] = Relationship(
        id="r1", type_name="Link", source_id="a", target_id="b"
    )

    before_r = Relationship(id="r1", type_name="Link", source_id="a", target_id="b")
    # after.id is intentionally different from the op id "r1"
    after_r = Relationship(id="DIFFERENT", type_name="Link", source_id="a", target_id="b")
    cr = ChangeRequest(
        relationships_modified=[ModifiedRelationship(id="r1", before=before_r, after=after_r)]
    )
    result = apply_change_request(model, cr)

    # The relationship must be stored under the canonical op id
    assert "r1" in result.relationships
    assert "DIFFERENT" not in result.relationships
    # And the relationship's own .id field must also be the canonical id
    assert result.relationships["r1"].id == "r1"
    # source_id/target_id come from after
    assert result.relationships["r1"].source_id == "a"
    assert result.relationships["r1"].target_id == "b"


# ---------------------------------------------------------------------------
# Fix 3 — relationship coverage
# ---------------------------------------------------------------------------


def test_before_mismatch_deleted_relationship():
    """before_mismatch conflict raised when deleted relationship snapshot doesn't match."""
    model = Model(_mm())
    model.elements["a"] = Element(id="a", type_name="Block", properties={})
    model.elements["b"] = Element(id="b", type_name="Block", properties={})
    model.relationships["r1"] = Relationship(
        id="r1", type_name="Link", source_id="a", target_id="b"
    )
    # Snapshot claims different target — mismatch
    wrong_snap = Relationship(id="r1", type_name="Link", source_id="a", target_id="a")
    cr = ChangeRequest(relationships_deleted=[wrong_snap])
    with pytest.raises(CRConflictError) as exc_info:
        apply_change_request(model, cr)
    conflicts = exc_info.value.conflicts
    assert len(conflicts) == 1
    assert conflicts[0].kind == "before_mismatch"
    assert conflicts[0].entity == "relationship"
    assert conflicts[0].id == "r1"


def test_clean_apply_modify_and_delete_relationships():
    """Clean apply that both modifies and deletes relationships."""
    model = Model(_mm())
    model.elements["a"] = Element(id="a", type_name="Block", properties={})
    model.elements["b"] = Element(id="b", type_name="Block", properties={})
    model.elements["c"] = Element(id="c", type_name="Block", properties={})
    model.relationships["keep"] = Relationship(
        id="keep", type_name="Link", source_id="a", target_id="b", properties={"x": 1}
    )
    model.relationships["mod"] = Relationship(
        id="mod", type_name="Link", source_id="a", target_id="b", properties={"x": 1}
    )
    model.relationships["del"] = Relationship(
        id="del", type_name="Link", source_id="b", target_id="c"
    )

    before_mod = Relationship(
        id="mod", type_name="Link", source_id="a", target_id="b", properties={"x": 1}
    )
    after_mod = Relationship(
        id="mod", type_name="Link", source_id="a", target_id="c", properties={"x": 2}
    )
    del_snap = Relationship(id="del", type_name="Link", source_id="b", target_id="c")

    cr = ChangeRequest(
        relationships_modified=[ModifiedRelationship(id="mod", before=before_mod, after=after_mod)],
        relationships_deleted=[del_snap],
    )
    result = apply_change_request(model, cr)

    # "keep" untouched, "mod" updated, "del" removed
    assert set(result.relationships.keys()) == {"keep", "mod"}
    assert result.relationships["mod"].target_id == "c"
    assert result.relationships["mod"].properties == {"x": 2}
    assert result.relationships["keep"].properties == {"x": 1}

    # Input model untouched
    assert set(model.relationships.keys()) == {"keep", "mod", "del"}
    assert model.relationships["mod"].target_id == "b"


def test_relationship_modify_bumps_rev():
    """Modifying a relationship bumps its rev by exactly 1."""
    model = Model(_mm())
    model.elements["a"] = Element(id="a", type_name="Block", properties={})
    model.elements["b"] = Element(id="b", type_name="Block", properties={})
    model.relationships["r1"] = Relationship(
        id="r1", type_name="Link", source_id="a", target_id="b", rev=7
    )

    before_r = Relationship(id="r1", type_name="Link", source_id="a", target_id="b")
    after_r = Relationship(id="r1", type_name="Link", source_id="b", target_id="a")
    cr = ChangeRequest(
        relationships_modified=[ModifiedRelationship(id="r1", before=before_r, after=after_r)]
    )
    result = apply_change_request(model, cr)
    assert result.relationships["r1"].rev == 8  # 7 + 1
