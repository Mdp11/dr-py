from __future__ import annotations

from fastapi import APIRouter, Depends

from data_rover.core.repository.file_store import FileRepository
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from ..deps import ModelIndex, get_index, get_repository
from ..schemas import IssueOut, ValidateRequest
from ._snapshot import _build_model_from_payload

router = APIRouter()


@router.post("/models/{name}/validate")
def validate_model(
    name: str,
    payload: ValidateRequest | None = None,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> list[IssueOut]:
    metamodel = repo.load_metamodel(index.get(name))
    if payload is not None and payload.inline is not None:
        model = _build_model_from_payload(
            metamodel,
            payload.inline.elements,
            payload.inline.relationships,
        )
    else:
        model = repo.load_model(name, metamodel)
    scope = Scope(payload.scope) if payload and payload.scope is not None else Scope.all()
    issues = default_pipeline().validate(model, scope)
    return [IssueOut.from_core(i) for i in issues]
