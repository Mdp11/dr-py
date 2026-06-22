"""Unit tests for build_model_from_dicts strict/non-strict mode.

TDD: these tests are written BEFORE the strict= param is added. They drive the
implementation of the ``strict`` keyword on ``_guard_element``,
``_guard_relationship``, and ``build_model_from_dicts``.

When strict=True (default):
- unknown element type -> 422
- unknown relationship type -> 422

When strict=False:
- unknown element type -> element is loaded with its original type_name
- unknown relationship type -> relationship is loaded with its original type_name
  (provided source/target elements exist)

Regardless of strict mode:
- duplicate element id -> 422
- relationship with absent source/target -> 422 (structural — always enforced)
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.api.routes._snapshot import build_model_from_dicts

# Minimal metamodel with one element type "Node" and one relationship "Link".
_MM_YAML = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""


@pytest.fixture()
def mm():
    return load_metamodel_str(_MM_YAML)


# ---------------------------------------------------------------------------
# strict=True (default) — unknown types must be rejected
# ---------------------------------------------------------------------------


def test_strict_unknown_element_type_raises(mm) -> None:
    """Unknown element type raises 422 in strict (default) mode."""
    raw = {"elements": [{"id": "e1", "type_name": "Ghost"}], "relationships": []}
    with pytest.raises(HTTPException) as exc_info:
        build_model_from_dicts(mm, raw)
    assert exc_info.value.status_code == 422
    assert "Ghost" in exc_info.value.detail


def test_strict_unknown_relationship_type_raises(mm) -> None:
    """Unknown relationship type raises 422 in strict (default) mode."""
    raw = {
        "elements": [
            {"id": "e1", "type_name": "Node"},
            {"id": "e2", "type_name": "Node"},
        ],
        "relationships": [
            {
                "id": "r1",
                "type_name": "Phantom",
                "source_id": "e1",
                "target_id": "e2",
            }
        ],
    }
    with pytest.raises(HTTPException) as exc_info:
        build_model_from_dicts(mm, raw)
    assert exc_info.value.status_code == 422
    assert "Phantom" in exc_info.value.detail


# ---------------------------------------------------------------------------
# strict=False — unknown types are tolerated; element/relationship survives
# ---------------------------------------------------------------------------


def test_nonstrict_unknown_element_type_loads(mm) -> None:
    """With strict=False, an element of an unknown type is loaded as-is."""
    raw = {"elements": [{"id": "e1", "type_name": "Ghost"}], "relationships": []}
    model = build_model_from_dicts(mm, raw, strict=False)
    assert "e1" in model.elements
    assert model.elements["e1"].type_name == "Ghost"


def test_nonstrict_unknown_relationship_type_loads(mm) -> None:
    """With strict=False, a relationship of an unknown type is loaded when
    source and target elements are present."""
    raw = {
        "elements": [
            {"id": "e1", "type_name": "Node"},
            {"id": "e2", "type_name": "Node"},
        ],
        "relationships": [
            {
                "id": "r1",
                "type_name": "Phantom",
                "source_id": "e1",
                "target_id": "e2",
            }
        ],
    }
    model = build_model_from_dicts(mm, raw, strict=False)
    assert "r1" in model.relationships
    assert model.relationships["r1"].type_name == "Phantom"


# ---------------------------------------------------------------------------
# strict=False STILL enforces structural guards
# ---------------------------------------------------------------------------


def test_nonstrict_duplicate_element_id_still_raises(mm) -> None:
    """Duplicate element id is always a 422, even in non-strict mode."""
    raw = {
        "elements": [
            {"id": "e1", "type_name": "Ghost"},
            {"id": "e1", "type_name": "Ghost"},
        ],
        "relationships": [],
    }
    with pytest.raises(HTTPException) as exc_info:
        build_model_from_dicts(mm, raw, strict=False)
    assert exc_info.value.status_code == 422
    assert "e1" in exc_info.value.detail


def test_nonstrict_relationship_absent_source_still_raises(mm) -> None:
    """Relationship referencing a non-existent source element is always a 422."""
    raw = {
        "elements": [{"id": "e2", "type_name": "Node"}],
        "relationships": [
            {
                "id": "r1",
                "type_name": "Phantom",
                "source_id": "missing",
                "target_id": "e2",
            }
        ],
    }
    with pytest.raises(HTTPException) as exc_info:
        build_model_from_dicts(mm, raw, strict=False)
    assert exc_info.value.status_code == 422
    assert "missing" in exc_info.value.detail


def test_nonstrict_relationship_absent_target_still_raises(mm) -> None:
    """Relationship referencing a non-existent target element is always a 422."""
    raw = {
        "elements": [{"id": "e1", "type_name": "Node"}],
        "relationships": [
            {
                "id": "r1",
                "type_name": "Phantom",
                "source_id": "e1",
                "target_id": "missing",
            }
        ],
    }
    with pytest.raises(HTTPException) as exc_info:
        build_model_from_dicts(mm, raw, strict=False)
    assert exc_info.value.status_code == 422
    assert "missing" in exc_info.value.detail
