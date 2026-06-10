from __future__ import annotations

from fastapi import HTTPException

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from ..schemas import ElementOut, RelationshipOut


def _build_model_from_payload(
    metamodel: Metamodel,
    elements: list[ElementOut],
    relationships: list[RelationshipOut],
) -> Model:
    """Materialize a `Model` from snapshot/inline payload data.

    Shared by `POST /model`, `PUT /model/snapshot`, and the inline branch of
    `POST /model/validate` so all three endpoints apply the same guards:

    - element/relationship type must exist in the metamodel
    - abstract types cannot be instantiated
    - element and relationship ids must be unique within the payload
    - relationship endpoints must resolve to elements in the payload
    """
    model = Model(metamodel)

    seen_element_ids: set[str] = set()
    for e in elements:
        et = metamodel.element_type(e.type_name)
        if et is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown element type {e.type_name!r}",
            )
        if et.abstract:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Element type {e.type_name!r} is abstract and cannot be "
                    f"instantiated"
                ),
            )
        if e.id in seen_element_ids:
            raise HTTPException(
                status_code=422,
                detail=f"Duplicate element id {e.id!r} in snapshot",
            )
        seen_element_ids.add(e.id)
        model.elements[e.id] = Element(
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
            rev=e.rev,
        )

    seen_relationship_ids: set[str] = set()
    for r in relationships:
        if metamodel.relationship_type(r.type_name) is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown relationship type {r.type_name!r}",
            )
        if r.source_id not in model.elements:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Relationship {r.id!r} references unknown source {r.source_id!r}"
                ),
            )
        if r.target_id not in model.elements:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Relationship {r.id!r} references unknown target {r.target_id!r}"
                ),
            )
        if r.id in seen_relationship_ids:
            raise HTTPException(
                status_code=422,
                detail=f"Duplicate relationship id {r.id!r} in snapshot",
            )
        seen_relationship_ids.add(r.id)
        model.relationships[r.id] = Relationship(
            id=r.id,
            type_name=r.type_name,
            source_id=r.source_id,
            target_id=r.target_id,
            properties=dict(r.properties),
            rev=r.rev,
        )

    # dicts were populated directly, bypassing the mutation boundary
    model.indexes.rebuild()
    return model
