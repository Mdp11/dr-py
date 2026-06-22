from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model, build_rebind_view

_MM_A = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""
# Candidate where Contains is NOT containment.
_MM_B = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: false
    source: Node
    target: Node
"""


def _model_with_contains() -> Model:
    m = Model(load_metamodel_str(_MM_A))
    a = m.create_element("Node")
    b = m.create_element("Node")
    m.connect("Contains", a.id, b.id)
    return m, a.id, b.id


def test_view_shares_payload_by_reference() -> None:
    m, _a, _b = _model_with_contains()
    view = build_rebind_view(m, load_metamodel_str(_MM_B))
    assert view.elements is m.elements
    assert view.relationships is m.relationships
    assert view.metamodel is not m.metamodel


def test_view_rebuilds_index_against_candidate() -> None:
    # Under MM_A, b has a containment parent a; under MM_B (Contains not
    # containment) the view's index must report NO containment parent.
    m, a_id, b_id = _model_with_contains()
    assert list(m.indexes.parents_of(b_id)) == [a_id]  # live index unchanged
    view = build_rebind_view(m, load_metamodel_str(_MM_B))
    assert list(view.indexes.parents_of(b_id)) == []
    assert view.indexes is not m.indexes


def test_view_does_not_mutate_live_index() -> None:
    m, a_id, b_id = _model_with_contains()
    build_rebind_view(m, load_metamodel_str(_MM_B))
    assert list(m.indexes.parents_of(b_id)) == [a_id]
