from __future__ import annotations

import pytest

from data_rover.core.view import ViewError, load_view_str


def test_load_minimal_view() -> None:
    view = load_view_str('{"name": "V1", "folders": []}')
    assert view.name == "V1"
    assert view.folders == []


def test_load_nested_folders_and_elements() -> None:
    view = load_view_str(
        """
        {
          "name": "Operational",
          "folders": [
            {
              "name": "Systems",
              "folders": [
                {"name": "Power", "folders": [], "elements": ["e_1", "e_2"]}
              ],
              "elements": ["e_3"]
            }
          ]
        }
        """
    )
    assert view.name == "Operational"
    assert len(view.folders) == 1
    systems = view.folders[0]
    assert systems.name == "Systems"
    assert systems.elements == ["e_3"]
    assert len(systems.folders) == 1
    power = systems.folders[0]
    assert power.name == "Power"
    assert power.elements == ["e_1", "e_2"]


def test_load_rejects_bad_json() -> None:
    with pytest.raises(ViewError, match="Malformed"):
        load_view_str("not json")


def test_load_rejects_non_object_root() -> None:
    with pytest.raises(ViewError, match="must be a JSON object"):
        load_view_str("[]")


def test_load_rejects_missing_name() -> None:
    with pytest.raises(ViewError, match="Invalid view"):
        load_view_str('{"folders": []}')
