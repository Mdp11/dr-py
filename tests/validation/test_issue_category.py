from __future__ import annotations

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.issue import Issue, IssueCategory, Severity
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

# minimal metamodel: a containment relationship so we can build a cycle
MM = """
name: cat-test
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    mappings:
      - source: Node
        target: Node
"""


def test_issue_defaults_to_conformance() -> None:
    i = Issue(Severity.ERROR, "x", ["e1"])
    assert i.category is IssueCategory.CONFORMANCE


def test_containment_cycle_is_structural() -> None:
    mm = load_metamodel_str(MM)
    model = Model(mm)
    a = model.create_element("Node")
    b = model.create_element("Node")
    model.connect("Contains", a.id, b.id)
    model.connect("Contains", b.id, a.id)  # cycle
    issues = default_pipeline().validate(model, Scope.all())
    cyc = [i for i in issues if "cycle" in i.message.lower()]
    assert cyc and all(i.category is IssueCategory.STRUCTURAL for i in cyc)


def test_two_parents_is_structural() -> None:
    mm = load_metamodel_str(MM)
    model = Model(mm)
    parent1 = model.create_element("Node")
    parent2 = model.create_element("Node")
    child = model.create_element("Node")
    model.connect("Contains", parent1.id, child.id)
    model.connect("Contains", parent2.id, child.id)  # two parents
    issues = default_pipeline().validate(model, Scope.all())
    multi = [i for i in issues if "containment parents" in i.message]
    assert multi and all(i.category is IssueCategory.STRUCTURAL for i in multi)
