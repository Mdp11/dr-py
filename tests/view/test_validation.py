from __future__ import annotations

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.issue import Severity
from data_rover.core.view.schema import Folder, View
from data_rover.core.view.validation import validate_view

METAMODEL = """
elements:
  - name: Block
    properties: []
  - name: Part
    properties: []
relationships:
  - name: Contains
    containment: true
    source: Block
    target: Part
"""


def _model_with(block_ids: list[str], part_ids: list[tuple[str, str]]) -> Model:
    mm = load_metamodel_str(METAMODEL)
    m = Model(mm)
    from data_rover.core.model.element import Element
    from data_rover.core.model.relationship import Relationship

    for bid in block_ids:
        m.elements[bid] = Element(id=bid, type_name="Block", properties={})
    for pid, parent_bid in part_ids:
        m.elements[pid] = Element(id=pid, type_name="Part", properties={})
        rid = f"r_{pid}"
        m.relationships[rid] = Relationship(
            id=rid,
            type_name="Contains",
            source_id=parent_bid,
            target_id=pid,
        )
    return m


def test_clean_view_has_no_warnings() -> None:
    model = _model_with(["b1", "b2"], [])
    view = View(
        name="V",
        folders=[Folder(name="A", elements=["b1"]), Folder(name="B", elements=["b2"])],
    )
    assert validate_view(view, model) == []


def test_missing_element_warning() -> None:
    model = _model_with(["b1"], [])
    view = View(
        name="V",
        folders=[Folder(name="A", elements=["b1", "ghost"])],
    )
    issues = validate_view(view, model)
    assert len(issues) == 1
    assert issues[0].severity is Severity.WARNING
    assert "ghost" in issues[0].message
    assert issues[0].target_ids == ["ghost"]


def test_contained_element_placement_warning() -> None:
    model = _model_with(["b1"], [("p1", "b1")])
    view = View(name="V", folders=[Folder(name="A", elements=["p1"])])
    issues = validate_view(view, model)
    assert len(issues) == 1
    assert "containment parent" in issues[0].message
    assert issues[0].target_ids == ["p1"]


def test_multiple_placement_warning() -> None:
    model = _model_with(["b1"], [])
    view = View(
        name="V",
        folders=[
            Folder(name="A", elements=["b1"]),
            Folder(name="B", elements=["b1"]),
        ],
    )
    issues = validate_view(view, model)
    assert len(issues) == 1
    assert "multiple folders" in issues[0].message
    assert issues[0].target_ids == ["b1"]


def test_duplicate_sibling_folder_warning() -> None:
    model = _model_with(["b1"], [])
    view = View(
        name="V",
        folders=[Folder(name="A"), Folder(name="A")],
    )
    issues = validate_view(view, model)
    assert len(issues) == 1
    assert "duplicate top-level folder" in issues[0].message


def test_duplicate_nested_folder_warning() -> None:
    model = _model_with(["b1"], [])
    view = View(
        name="V",
        folders=[
            Folder(
                name="Top",
                folders=[Folder(name="X"), Folder(name="X")],
            )
        ],
    )
    issues = validate_view(view, model)
    assert len(issues) == 1
    assert "duplicate folder 'X' under 'Top'" in issues[0].message
