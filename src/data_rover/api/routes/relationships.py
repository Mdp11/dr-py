from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from data_rover.core.repository.file_store import FileRepository

from ..deps import ModelIndex, get_index, get_repository
from ..schemas import CreateRelationshipRequest, RelationshipOut

router = APIRouter()


def _load(name: str, repo: FileRepository, index: ModelIndex):
    metamodel = repo.load_metamodel(index.get(name))
    return metamodel, repo.load_model(name, metamodel)


@router.get("/models/{name}/relationships")
def list_relationships(
    name: str,
    type: str | None = None,
    source_id: str | None = None,
    target_id: str | None = None,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> list[RelationshipOut]:
    _, model = _load(name, repo, index)
    items = list(model.relationships.values())
    if type is not None:
        items = [r for r in items if r.type_name == type]
    if source_id is not None:
        items = [r for r in items if r.source_id == source_id]
    if target_id is not None:
        items = [r for r in items if r.target_id == target_id]
    return [RelationshipOut.from_core(r) for r in items]


@router.post("/models/{name}/relationships", status_code=201)
def create_relationship(
    name: str,
    payload: CreateRelationshipRequest,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> RelationshipOut:
    _, model = _load(name, repo, index)
    rel = model.connect(payload.type, payload.source_id, payload.target_id)
    repo.save_model(name, model)
    return RelationshipOut.from_core(rel)


@router.delete("/models/{name}/relationships/{relationship_id}", status_code=204)
def delete_relationship(
    name: str,
    relationship_id: str,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> Response:
    _, model = _load(name, repo, index)
    model.disconnect(relationship_id)
    repo.save_model(name, model)
    return Response(status_code=204)
