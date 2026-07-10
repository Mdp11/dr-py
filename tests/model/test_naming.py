from data_rover.core.model.element import Element
from data_rover.core.model.naming import display_name


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
