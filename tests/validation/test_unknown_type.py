from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model, build_rebind_view
from data_rover.core.validation.issue import IssueCategory
from data_rover.core.validation.pipeline import default_pipeline

_MM_WITH = """
elements:
  - name: Node
  - name: Gadget
relationships:
  - name: Link
    source: Node
    target: Node
"""
_MM_WITHOUT = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""


def test_unknown_element_type_is_conformance() -> None:
    m = Model(load_metamodel_str(_MM_WITH))
    g = m.create_element("Gadget")
    view = build_rebind_view(m, load_metamodel_str(_MM_WITHOUT))
    issues = default_pipeline().validate(view)
    unknown = [i for i in issues if g.id in i.target_ids and "unknown type" in i.message]
    assert len(unknown) == 1
    assert unknown[0].category is IssueCategory.CONFORMANCE


def test_known_type_emits_no_unknown_issue() -> None:
    m = Model(load_metamodel_str(_MM_WITH))
    n = m.create_element("Node")
    issues = default_pipeline().validate(m)
    assert not any("unknown type" in i.message for i in issues if n.id in i.target_ids)


_MM_REL = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
_MM_NO_REL = """
elements:
  - name: Node
"""


def test_unknown_relationship_type_is_conformance() -> None:
    m = Model(load_metamodel_str(_MM_REL))
    a = m.create_element("Node")
    b = m.create_element("Node")
    r = m.connect("Link", a.id, b.id)
    view = build_rebind_view(m, load_metamodel_str(_MM_NO_REL))
    issues = default_pipeline().validate(view)
    unknown = [i for i in issues if r.id in i.target_ids and "unknown type" in i.message]
    assert len(unknown) == 1
    assert unknown[0].category is IssueCategory.CONFORMANCE
