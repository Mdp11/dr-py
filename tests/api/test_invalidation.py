"""Table-driven tests for `touched_keys` (Phase B): each op kind maps to an
exact set of read-keys. Batches are applied through the REAL `_apply_batch`
so the `_BatchResult` shapes match production."""

from __future__ import annotations

from data_rover.api.invalidation import touched_keys
from data_rover.api.routes.ops import _apply_batch, _BatchResult
from data_rover.api.schemas import OPS_ADAPTER
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Base",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Derived", extends="Base"),
        ],
        relationships=[
            RelationshipType(
                name="Owns", containment=True, source="Base", target="Base"
            ),
            RelationshipType(
                name="Uses",
                source="Base",
                target="Base",
                properties=[PropertyDef(name="label", datatype="string")],
            ),
        ],
    )


def _model() -> Model:
    m = Model(_mm())
    a = m.restore_element("a", "Base")
    b = m.restore_element("b", "Derived")
    m.restore_element("c", "Base")
    m.set_property(a, "name", "A")
    m.set_property(b, "name", "B")
    m.connect("Owns", "a", "b")
    return m


def _apply(model: Model, ops: list[dict]) -> _BatchResult:
    return _apply_batch(model, OPS_ADAPTER.validate_python(ops), restore=False)


def test_update_element_keys() -> None:
    model = _model()
    res = _apply(
        model,
        [{"kind": "update_element", "id": "b", "properties_patch": {"name": "B2"}}],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset(
        {
            ("el", "b"),
            ("children", "a"),  # b's projection rides a.children()
            ("scan", None),
            ("scan", "Derived"),
            ("scan", "Base"),  # ancestor scans see Derived elements
        }
    )


def test_update_element_with_two_containment_parents_touches_both() -> None:
    """Two containment parents is a structural validation issue, but this
    engine deliberately HOLDS non-conformant data (imported/migrated models),
    so it is reachable. `children()` is derived per-parent from that
    parent's OWN outgoing containment edges (`bridge.py`'s `_op_children`),
    not from a single first-parent lookup, so BOTH `c.children()` and
    `a.children()` inline `b`'s projection once `b` is doubly-owned. A
    property update to `b` must touch both parents' `("children", ...)`
    keys, or a cell that read the second parent's `children()` would survive
    eviction with a stale value."""
    model = _model()
    model.connect("Owns", "c", "b")  # b now has two containment parents: a, c
    res = _apply(
        model,
        [{"kind": "update_element", "id": "b", "properties_patch": {"name": "B2"}}],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset(
        {
            ("el", "b"),
            ("children", "a"),
            ("children", "c"),
            ("scan", None),
            ("scan", "Derived"),
            ("scan", "Base"),
        }
    )


def test_update_root_element_has_no_children_key() -> None:
    model = _model()
    res = _apply(
        model,
        [{"kind": "update_element", "id": "a", "properties_patch": {"name": "A2"}}],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset({("el", "a"), ("scan", None), ("scan", "Base")})


def test_create_relationship_keys() -> None:
    model = _model()
    res = _apply(
        model,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r1",
                "type_name": "Uses",
                "source_id": "a",
                "target_id": "c",
                "properties": {},
            }
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset({("out", "a"), ("in", "c")})


def test_containment_relationship_adds_children_and_parent() -> None:
    model = _model()
    res = _apply(
        model,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r2",
                "type_name": "Owns",
                "source_id": "a",
                "target_id": "c",
                "properties": {},
            }
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset(
        {("out", "a"), ("in", "c"), ("children", "a"), ("parent", "c")}
    )


def test_delete_element_cascade_keys() -> None:
    model = _model()
    res = _apply(model, [{"kind": "delete_element", "id": "b"}])
    keys = touched_keys(model, model.metamodel, res)
    # b deleted (type Derived, from the inverse unit); the a->b Owns
    # relationship cascaded away with it.
    assert keys == frozenset(
        {
            ("el", "b"),
            ("scan", None),
            ("scan", "Derived"),
            ("scan", "Base"),
            ("out", "a"),
            ("in", "b"),
            ("children", "a"),
            ("parent", "b"),
        }
    )


def test_create_element_keys() -> None:
    model = _model()
    res = _apply(
        model,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Derived",
                "properties": {"name": "X"},
            }
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    new_id = res.id_map["tmp_x"]
    assert keys == frozenset(
        {("el", new_id), ("scan", None), ("scan", "Derived"), ("scan", "Base")}
    )


def test_typed_scan_always_carries_untyped_scan() -> None:
    """Pins the Task 7 carry-in: `evict_touched` intersects `touched` with a
    cell's read-set with NO expansion, so a cell that only recorded
    `("scan", None)` (an untyped `dr.elements()` scan) would survive a
    touched set containing only `("scan", "Derived")` — a stale-value bug,
    since that untyped scan's page inlines every element regardless of type
    and therefore DID see the change: if any typed scan key is present,
    `("scan", None)` must be too."""
    model = _model()
    res = _apply(
        model,
        [{"kind": "update_element", "id": "b", "properties_patch": {"name": "B3"}}],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys is not None
    scan_types = {t for kind, t in keys if kind == "scan" and t is not None}
    assert scan_types, "expected at least one typed scan key in this fixture"
    assert ("scan", None) in keys


def test_missing_deleted_element_metadata_returns_none() -> None:
    """Bail-out path: deleted-entity metadata is recovered from the batch's
    inverse units, which `_apply_batch` always records. A hand-built
    `_BatchResult` that claims a deletion without that metadata simulates
    the "unreachable by construction" defensive branch — `touched_keys` must
    return None (clear everything) rather than silently skip the deletion's
    keys."""
    model = _model()
    res = _BatchResult()
    res.deleted_element_ids["ghost"] = None
    assert touched_keys(model, model.metamodel, res) is None


def test_update_relationship_keys() -> None:
    """`rel_keys` is exercised via `create_relationship` in the tests above;
    this pins the same computation reached through `update_relationship` on
    an already-existing (not batch-created) relationship, so the
    `changed_relationship_ids` loop's `model.relationships.get(rid)` lookup
    is genuinely exercised against a pre-existing entity."""
    model = _model()
    created = _apply(
        model,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_u1",
                "type_name": "Uses",
                "source_id": "a",
                "target_id": "c",
                "properties": {"label": "x"},
            }
        ],
    )
    rel_id = created.id_map["tmp_u1"]
    res = _apply(
        model,
        [
            {
                "kind": "update_relationship",
                "id": rel_id,
                "properties_patch": {"label": "y"},
            }
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset({("out", "a"), ("in", "c")})


def test_reparent_batch_touches_both_old_and_new_parent_children() -> None:
    """A single batch that deletes the old containment edge and creates the
    new one (a re-parent) must touch BOTH parents' `("children", ...)` keys
    — a cell that read the OLD parent's `children()` (no longer showing the
    reparented element) is just as stale as one that read the new parent's,
    so both must be evicted."""
    model = _model()
    old_owns_id = next(iter(model.indexes.outgoing_ids("a")))
    res = _apply(
        model,
        [
            {"kind": "delete_relationship", "id": old_owns_id},
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r3",
                "type_name": "Owns",
                "source_id": "c",
                "target_id": "b",
                "properties": {},
            },
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset(
        {
            ("out", "a"),
            ("in", "b"),
            ("children", "a"),
            ("parent", "b"),
            ("out", "c"),
            ("children", "c"),
        }
    )
