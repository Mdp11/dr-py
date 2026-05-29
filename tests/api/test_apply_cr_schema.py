"""Tests for ChangeRequestIn schema and its to_core() conversion."""
from __future__ import annotations

import pytest

from data_rover.api.schemas import ChangeRequestIn


def _make_cr_dict() -> dict:
    """Build a minimal but complete datarover.cr/v1 dict."""
    return {
        "format": "datarover.cr/v1",
        "createdAt": "2024-01-01T00:00:00Z",
        "baseline": {
            "filename": "model.json",
            "elementCount": 1,
            "relationshipCount": 0,
        },
        "ops": {
            "elements": {
                "added": [
                    {
                        "id": "e-added",
                        "type_name": "Block",
                        "properties": {"name": "NewBlock"},
                        "rev": 0,
                    }
                ],
                "modified": [
                    {
                        "id": "e-modified",
                        "before": {
                            "id": "e-modified",
                            "type_name": "Block",
                            "properties": {"name": "OldName"},
                            "rev": 0,
                        },
                        "after": {
                            "id": "e-modified",
                            "type_name": "Block",
                            "properties": {"name": "NewName"},
                            "rev": 0,
                        },
                    }
                ],
                "deleted": [
                    {
                        "id": "e-deleted",
                        "type_name": "Block",
                        "properties": {"name": "GoneBlock"},
                        "rev": 0,
                    }
                ],
            },
            "relationships": {
                "added": [],
                "modified": [],
                "deleted": [],
            },
        },
    }


def test_change_request_in_validates_format() -> None:
    d = _make_cr_dict()
    cr_in = ChangeRequestIn.model_validate(d)
    assert cr_in.format == "datarover.cr/v1"


def test_to_core_elements_added() -> None:
    d = _make_cr_dict()
    core = ChangeRequestIn.model_validate(d).to_core()
    assert len(core.elements_added) == 1
    assert core.elements_added[0].id == "e-added"
    assert core.elements_added[0].type_name == "Block"
    assert core.elements_added[0].properties == {"name": "NewBlock"}


def test_to_core_elements_modified() -> None:
    d = _make_cr_dict()
    core = ChangeRequestIn.model_validate(d).to_core()
    assert len(core.elements_modified) == 1
    mod = core.elements_modified[0]
    assert mod.id == "e-modified"
    assert mod.before.properties["name"] == "OldName"
    assert mod.after.properties["name"] == "NewName"


def test_to_core_elements_deleted() -> None:
    d = _make_cr_dict()
    core = ChangeRequestIn.model_validate(d).to_core()
    assert len(core.elements_deleted) == 1
    assert core.elements_deleted[0].id == "e-deleted"


def test_to_core_relationships_empty() -> None:
    d = _make_cr_dict()
    core = ChangeRequestIn.model_validate(d).to_core()
    assert core.relationships_added == []
    assert core.relationships_modified == []
    assert core.relationships_deleted == []


def test_change_request_in_rejects_wrong_format() -> None:
    d = _make_cr_dict()
    d["format"] = "wrong/v99"
    with pytest.raises(Exception):
        ChangeRequestIn.model_validate(d)
