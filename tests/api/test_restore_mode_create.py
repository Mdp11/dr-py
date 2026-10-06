"""A create op in restore mode, where the journal's inverses are replayed.

A create whose ``temp_id`` is not a ``tmp_`` id names the canonical id to
reinstate; a stray ``id`` hint beside it means nothing and is ignored. Under a
``tmp_`` id the hint is the id the entity is created under.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import CreateElementOp, CreateRelationshipOp
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""


def _model() -> Model:
    return Model(load_metamodel_str(_MM))


def _element(temp_id: str, id: str | None = None) -> CreateElementOp:
    return CreateElementOp(
        kind="create_element", temp_id=temp_id, type_name="Node", id=id
    )


def _link(temp_id: str, id: str | None = None) -> CreateRelationshipOp:
    return CreateRelationshipOp(
        kind="create_relationship",
        temp_id=temp_id,
        type_name="Link",
        source_id="a",
        target_id="b",
        id=id,
    )


def test_a_restored_element_takes_the_canonical_id_and_ignores_a_stray_hint() -> None:
    model = _model()
    res = _apply_batch(model, [_element("e_7", id="stray")], restore=True)
    assert set(model.elements) == {"e_7"}
    assert "e_7" not in res.id_map
    (canonical,) = res.canonical_ops
    assert isinstance(canonical, CreateElementOp)
    assert (canonical.temp_id, canonical.id) == ("e_7", None)


def test_a_restored_relationship_takes_the_canonical_id_and_ignores_a_stray_hint() -> (
    None
):
    model = _model()
    _apply_batch(model, [_element("a"), _element("b")], restore=True)
    res = _apply_batch(model, [_link("r_7", id="stray")], restore=True)
    assert set(model.relationships) == {"r_7"}
    assert "r_7" not in res.id_map
    (canonical,) = res.canonical_ops
    assert isinstance(canonical, CreateRelationshipOp)
    assert (canonical.temp_id, canonical.id) == ("r_7", None)


def test_a_stray_hint_beside_a_canonical_id_does_not_reserve_the_hint() -> None:
    """The hint is dropped, so the id it names stays free."""
    model = _model()
    _apply_batch(model, [_element("e_7", id="e_8")], restore=True)
    _apply_batch(model, [_element("e_8")], restore=True)
    assert set(model.elements) == {"e_7", "e_8"}


def test_under_a_temp_id_the_hint_is_the_id_created_in_restore_mode_too() -> None:
    model = _model()
    res = _apply_batch(model, [_element("tmp_x", id="e_9")], restore=True)
    assert set(model.elements) == {"e_9"}
    assert res.id_map == {"tmp_x": "e_9"}


def test_outside_restore_mode_a_canonical_id_is_refused_hint_or_not() -> None:
    model = _model()
    with pytest.raises(HTTPException) as refused:
        _apply_batch(model, [_element("e_7", id="stray")], restore=False)
    assert refused.value.status_code == 422
    assert "must start with 'tmp_'" in str(refused.value.detail)
    assert not model.elements
