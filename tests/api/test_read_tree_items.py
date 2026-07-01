from data_rover.api.routes.read import _display_name, _tree_item
from data_rover.core.model.element import Element


def _el(eid, props, type_name="Thing"):
    return Element(id=eid, type_name=type_name, properties=props)


def test_display_name_is_case_insensitive():
    assert _display_name(_el("e1", {"name": "Alpha"})) == "Alpha"
    assert _display_name(_el("e2", {"Name": "Beta"})) == "Beta"
    assert _display_name(_el("e3", {"NAME": "Gamma"})) == "Gamma"
    # exact lowercase wins over other casings
    assert _display_name(_el("e4", {"Name": "cap", "name": "low"})) == "low"
    # empty / missing / non-string falls back to id
    assert _display_name(_el("e5", {"name": ""})) == "e5"
    assert _display_name(_el("e6", {})) == "e6"
    assert _display_name(_el("e7", {"name": 123})) == "e7"
