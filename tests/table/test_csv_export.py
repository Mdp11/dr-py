"""CSV renderer: layout mirroring of the xlsx writer, RFC-4180 quoting,
error-cell text, and the row-number pseudo-column (spec §6)."""

import csv
import io

import pytest

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.table.cells import ElementCell, ErrorCell, ValueCell
from data_rover.core.table.csv_export import render_csv


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


def _value(v: object) -> ValueCell:
    return ValueCell(present=True, value=v, element_id=None, editable=False)


def _parse(blob: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(blob.decode("utf-8"))))


def test_header_row_then_data_rows_utf8_no_bom():
    model, eid = _model()
    blob = render_csv(
        model,
        ["Block", "Mass"],
        [[ElementCell(element_id=eid), _value(12)]],
    )
    assert not blob.startswith(b"\xef\xbb\xbf")  # machine consumers: no BOM
    assert _parse(blob) == [["Block", "Mass"], ["Root", "12"]]


def test_rfc4180_quoting_of_commas_quotes_and_newlines():
    model, _ = _model()
    blob = render_csv(
        model,
        ["A", "B", "C"],
        [[_value('say "hi"'), _value("a,b"), _value("l1\nl2")]],
    )
    # csv.reader round-trips the quoting, proving it was correct
    assert _parse(blob) == [["A", "B", "C"], ['say "hi"', "a,b", "l1\nl2"]]
    # excel dialect terminates rows CRLF (RFC 4180)
    assert blob.endswith(b"\r\n")


def test_error_cells_render_error_text_like_xlsx():
    model, _ = _model()
    blob = render_csv(model, ["A"], [[ErrorCell(message="boom")]])
    assert _parse(blob)[1] == ["#ERROR: boom"]


def test_row_number_column_is_written_at_its_position():
    model, eid = _model()
    blob = render_csv(
        model,
        ["#", "Block"],
        [[ElementCell(element_id=eid)], [ElementCell(element_id=eid)]],
        row_number_col=0,
    )
    assert _parse(blob) == [["#", "Block"], ["1", "Root"], ["2", "Root"]]


def test_row_length_mismatch_and_bad_row_number_col_raise_value_error():
    model, _ = _model()
    with pytest.raises(ValueError):
        render_csv(model, ["A", "B"], [[_value(1)]])
    with pytest.raises(ValueError):
        render_csv(model, ["A"], [], row_number_col=5)
