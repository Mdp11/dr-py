from data_rover.core.model.element import Element
from data_rover.core.model.naming import display_name, name_of


def _el(eid: str, props: dict) -> Element:
    return Element(id=eid, type_name="Item", properties=props)


def test_exact_name_wins() -> None:
    assert display_name(_el("e1", {"name": "Alpha", "Name": "Beta"})) == "Alpha"


def test_case_insensitive_fallback() -> None:
    assert display_name(_el("e1", {"NAME": "Gamma"})) == "Gamma"


def test_empty_and_non_string_fall_back_to_id() -> None:
    assert display_name(_el("e1", {"name": ""})) == "e1"
    assert display_name(_el("e2", {"name": 7})) == "e2"
    assert display_name(_el("e3", {})) == "e3"


def test_list_valued_name_uses_first_non_empty_string() -> None:
    # A multiplicity-many `name` property (e.g. from a migrated legacy model)
    # stores a LIST — the first non-empty string entry is the display name.
    assert display_name(_el("e1", {"name": ["Alpha", "Beta"]})) == "Alpha"
    assert display_name(_el("e2", {"Name": ["", "Gamma"]})) == "Gamma"
    assert display_name(_el("e3", {"name": []})) == "e3"
    assert display_name(_el("e4", {"name": [7, None]})) == "e4"


def test_name_of_returns_name_or_none() -> None:
    # `name_of` is `display_name` without the id fallback: the fuzzy-search
    # scorer uses it so `Name`/`NAME` rank exactly like a lowercase `name`.
    assert name_of(_el("e1", {"name": "Alpha"})) == "Alpha"
    assert name_of(_el("e1", {"Name": "Beta"})) == "Beta"
    assert name_of(_el("e1", {"name": "Alpha", "Name": "Beta"})) == "Alpha"
    assert name_of(_el("e1", {"NAME": ["", "Gamma"]})) == "Gamma"
    assert name_of(_el("e1", {"name": ""})) is None
    assert name_of(_el("e1", {})) is None
