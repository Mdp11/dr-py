from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from data_rover.core.model.model import Model
from data_rover.core.repository.file_store import FileRepository

from ..deps import ModelIndex, get_index, get_repository
from ..schemas import CreateModelRequest, ModelOut, ModelRef, SnapshotIn, SnapshotOut
from ._snapshot import _build_model_from_payload

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
    # Narrow probe for existence so we get a clean 404 without re-parsing the
    # full model. The subsequent `save_model(expected_rev=...)` provides the
    # optimistic-concurrency check.
    if not repo.exists(name):
        raise HTTPException(status_code=404, detail=f"No model named {name!r}")

    model = _build_model_from_payload(
        metamodel, payload.elements, payload.relationships
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
