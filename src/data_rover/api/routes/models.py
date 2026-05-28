from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.repository.file_store import FileRepository

from ..deps import ModelIndex, get_index, get_repository
from ..schemas import CreateModelRequest, ModelOut, ModelRef, SnapshotIn, SnapshotOut

router = APIRouter()


@router.get("/models")
def list_models(index: ModelIndex = Depends(get_index)) -> list[ModelRef]:
    return [ModelRef(name=n, metamodel=mm) for n, mm in sorted(index.all().items())]


@router.post("/models", status_code=201)
def create_model(
    payload: CreateModelRequest,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> ModelOut:
    metamodel = repo.load_metamodel(payload.metamodel)
    model = Model(metamodel)
    new_rev = repo.save_model(payload.name, model)
    index.set(payload.name, payload.metamodel)
    return ModelOut.from_core(payload.name, payload.metamodel, model, rev=new_rev)


@router.get("/models/{name}")
def get_model(
    name: str,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> ModelOut:
    metamodel_name = index.get(name)
    metamodel = repo.load_metamodel(metamodel_name)
    model = repo.load_model(name, metamodel)
    return ModelOut.from_core(name, metamodel_name, model, rev=repo.current_rev(name))


@router.put("/models/{name}/snapshot")
def snapshot_model(
    name: str,
    payload: SnapshotIn,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> SnapshotOut:
    metamodel_name = index.get(name)
    metamodel = repo.load_metamodel(metamodel_name)
    # Ensure the model already exists; load to surface a KeyError -> 404 if not.
    repo.load_model(name, metamodel)

    model = Model(metamodel)
    for e in payload.elements:
        if not metamodel.is_element_type(e.type_name):
            raise HTTPException(
                status_code=422,
                detail=f"Unknown element type {e.type_name!r}",
            )
        if not isinstance(e.properties, dict):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Element {e.id!r} properties must be an object"
                ),
            )
        model.elements[e.id] = Element(
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
            rev=e.rev,
        )
    for r in payload.relationships:
        if metamodel.relationship_type(r.type_name) is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown relationship type {r.type_name!r}",
            )
        if r.source_id not in model.elements:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Relationship {r.id!r} references unknown source "
                    f"{r.source_id!r}"
                ),
            )
        if r.target_id not in model.elements:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Relationship {r.id!r} references unknown target "
                    f"{r.target_id!r}"
                ),
            )
        if not isinstance(r.properties, dict):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Relationship {r.id!r} properties must be an object"
                ),
            )
        model.relationships[r.id] = Relationship(
            id=r.id,
            type_name=r.type_name,
            source_id=r.source_id,
            target_id=r.target_id,
            properties=dict(r.properties),
            rev=r.rev,
        )

    new_rev = repo.save_model(name, model, expected_rev=payload.rev)
    return SnapshotOut(rev=new_rev)


@router.delete("/models/{name}", status_code=204)
def delete_model(
    name: str,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> Response:
    index.get(name)
    path = repo._path(name, "model", "json")
    if path.exists():
        path.unlink()
    index.delete(name)
    return Response(status_code=204)
