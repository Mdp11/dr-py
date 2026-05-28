from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.repository.file_store import FileRepository
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from ..deps import ModelIndex, get_index, get_repository
from ..schemas import InlineModel, IssueOut, ValidateRequest

router = APIRouter()


def _build_inline_model(metamodel, inline: InlineModel) -> Model:
    model = Model(metamodel)
    for e in inline.elements:
        if not metamodel.is_element_type(e.type_name):
            raise HTTPException(
                status_code=422,
                detail=f"Unknown element type {e.type_name!r}",
            )
        model.elements[e.id] = Element(
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
            rev=e.rev,
        )
    for r in inline.relationships:
        if metamodel.relationship_type(r.type_name) is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown relationship type {r.type_name!r}",
            )
        model.relationships[r.id] = Relationship(
            id=r.id,
            type_name=r.type_name,
            source_id=r.source_id,
            target_id=r.target_id,
            properties=dict(r.properties),
            rev=r.rev,
        )
    return model


@router.post("/models/{name}/validate")
def validate_model(
    name: str,
    payload: ValidateRequest | None = None,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> list[IssueOut]:
    metamodel = repo.load_metamodel(index.get(name))
    if payload is not None and payload.inline is not None:
        model = _build_inline_model(metamodel, payload.inline)
    else:
        model = repo.load_model(name, metamodel)
    scope = Scope(payload.scope) if payload and payload.scope is not None else Scope.all()
    issues = default_pipeline().validate(model, scope)
    return [IssueOut.from_core(i) for i in issues]
