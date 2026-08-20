"""Display-text rendering shared by the xlsx writer and the CSV renderer."""

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.table.cell_text import cell_text
from data_rover.core.table.cells import (
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)


def _model() -> tuple[Model, str]:
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="name", datatype="string")]
            )
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "Root")
    return model, el.id


def test_element_cell_renders_display_name():
    model, eid = _model()
    assert cell_text(model, ElementCell(element_id=eid)) == "Root"
    assert cell_text(model, ElementCell(element_id=None)) == ""


def test_value_cell_passes_native_values_and_blanks_absence():
    model, _ = _model()
    assert cell_text(model, ValueCell(present=True, value=12, element_id=None, editable=False)) == 12
    assert cell_text(model, ValueCell(present=True, value=0, element_id=None, editable=False)) == 0
    assert cell_text(model, ValueCell(present=False, value=None, element_id=None, editable=False)) == ""
    assert cell_text(model, ValueCell(present=True, value=None, element_id=None, editable=False)) == ""


def test_values_and_elements_cells_join_with_semicolons():
    model, eid = _model()
    assert cell_text(model, ValuesCell(present=True, values=[1, "a"], total=2, truncated=False)) == "1; a"
    assert cell_text(model, ElementsCell(element_ids=[eid, eid], total=2, truncated=False)) == "Root; Root"


def test_error_and_pending_cells_render_error_text():
    model, _ = _model()
    assert cell_text(model, ErrorCell(message="boom")) == "#ERROR: boom"
    assert cell_text(model, PendingCell()) == "#ERROR: not computed"
