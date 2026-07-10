"""Order-index maintenance: the roots order must track every mutation path
and always equal what a fresh rebuild() computes (verify_consistent)."""

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
  - name: Links
    containment: false
    source: Item
    target: Item
"""


def _model() -> Model:
    return Model(load_metamodel_str(MM))


def _named(model: Model, name: str):
    el = model.create_element("Item")
    model.set_property(el, "name", name)
    return el


def test_create_orders_by_display_name_then_id() -> None:
    m = _model()
    beta = _named(m, "Beta")
    alpha = _named(m, "Alpha")
    unnamed = m.create_element("Item")  # display name falls back to id
    # UUIDv7 ids are lowercase-hex and timestamp-prefixed, so an id-fallback
    # root always sorts before an uppercase display name -- assert relative
    # order instead of absolute position (see task-3-report.md for detail).
    page = m.indexes.roots_page(0, 10)
    assert page.index(alpha.id) < page.index(beta.id)
    assert m.indexes.roots_count() == 3
    assert unnamed.id in page
    assert unnamed.id in list(m.indexes.iter_roots())
    m.indexes.verify_consistent()


def test_containment_edge_removes_and_restores_root() -> None:
    m = _model()
    parent = _named(m, "P")
    child = _named(m, "C")
    rel = m.connect("Contains", parent.id, child.id)
    assert m.indexes.roots_page(0, 10) == [parent.id]
    m.indexes.verify_consistent()
    m.disconnect(rel.id)
    assert set(m.indexes.roots_page(0, 10)) == {parent.id, child.id}
    m.indexes.verify_consistent()


def test_second_parent_does_not_double_remove() -> None:
    m = _model()
    p1, p2, child = _named(m, "P1"), _named(m, "P2"), _named(m, "C")
    r1 = m.connect("Contains", p1.id, child.id)
    m.connect("Contains", p2.id, child.id)  # second parent: child already non-root
    assert set(m.indexes.roots_page(0, 10)) == {p1.id, p2.id}
    m.disconnect(r1.id)  # still has p2 as parent -> still not a root
    assert set(m.indexes.roots_page(0, 10)) == {p1.id, p2.id}
    m.indexes.verify_consistent()


def test_non_containment_edge_is_ignored() -> None:
    m = _model()
    a, b = _named(m, "A"), _named(m, "B")
    m.connect("Links", a.id, b.id)
    assert m.indexes.roots_count() == 2
    m.indexes.verify_consistent()


def test_rename_repositions() -> None:
    m = _model()
    a, z = _named(m, "Alpha"), _named(m, "Zeta")
    assert m.indexes.roots_page(0, 10) == [a.id, z.id]
    m.set_property(a, "name", "Zulu")
    assert m.indexes.roots_page(0, 10) == [z.id, a.id]
    m.indexes.verify_consistent()


def test_delete_cascade_keeps_index_consistent() -> None:
    m = _model()
    parent = _named(m, "P")
    child = _named(m, "C")
    grandchild = _named(m, "G")
    m.connect("Contains", parent.id, child.id)
    m.connect("Contains", child.id, grandchild.id)
    m.delete_element(parent.id)  # cascades through child + grandchild
    assert m.indexes.roots_count() == 0
    m.indexes.verify_consistent()


def test_rebuild_parity() -> None:
    """Bulk-load path: populate dicts directly, rebuild, compare to hooks."""
    m = _model()
    parent = _named(m, "P")
    child = _named(m, "C")
    m.connect("Contains", parent.id, child.id)
    _named(m, "Free")
    expected = m.indexes.roots_order.as_list()
    m.indexes.rebuild()
    assert m.indexes.roots_order.as_list() == expected
    m.indexes.verify_consistent()
