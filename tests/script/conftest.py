"""Shared model-building helpers for `tests/script/`.

`tiny_model()` builds a tiny, deterministic model via the REAL `Metamodel`/
`Model` construction API (mirroring how `tests/model/*` build fixtures)
rather than hand-rolling dicts, so `BridgeDispatcher` is exercised against
the same object graph production code produces.
"""

from __future__ import annotations

import pytest

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model


def _metamodel() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Owns",
                containment=True,
                source="Building",
                target="Building",
            ),
        ],
    )


def tiny_model() -> Model:
    """Three `Building` elements (`b1`, `b2`, `b3`, each with a `name`) and one
    `Owns` containment relationship, `b1` -> `b2`.

    Element ids are pinned via `Model.restore_element` (the fixed-id insertion
    path used by undo/restore) rather than the default id generator, so tests
    can address elements by the literal ids (`"b1"`, ...) the task-5 brief's
    test file uses. `b3` is left both parent- and child-less so tests can
    assert the empty-containment edges (`parent`/`children` on a leaf with no
    owner).
    """
    model = Model(_metamodel())
    b1 = model.restore_element("b1", "Building")
    b2 = model.restore_element("b2", "Building")
    b3 = model.restore_element("b3", "Building")
    model.set_property(b1, "name", "Building One")
    model.set_property(b2, "name", "Building Two")
    model.set_property(b3, "name", "Building Three")
    model.connect("Owns", "b1", "b2")
    return model


@pytest.fixture
def small_model() -> Model:
    """Pytest fixture wrapping tiny_model() for tests that need a reusable model."""
    return tiny_model()
