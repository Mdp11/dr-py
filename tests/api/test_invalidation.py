"""Table-driven tests for `touched_keys` (Phase B): each op kind maps to an
exact set of read-keys. Batches are applied through the REAL `_apply_batch`
so the `_BatchResult` shapes match production."""

from __future__ import annotations

from data_rover.api.invalidation import touched_keys
from data_rover.api.routes.ops import _apply_batch
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
            RelationshipType(name="Uses", source="Base", target="Base"),
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


def _apply(model: Model, ops: list[dict]):
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
    and therefore DID see the change. `touched_keys` must never emit a typed
    `("scan", T)` key without `("scan", None)` alongside it, for every T it
    emits, not just the first."""
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
