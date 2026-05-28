from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from data_rover.core.repository.file_store import FileRepository

from ..deps import ModelIndex, get_index, get_repository
from ..schemas import CreateElementRequest, ElementOut, UpdateElementRequest

router = APIRouter()


def _load(name: str, repo: FileRepository, index: ModelIndex):
    metamodel = repo.load_metamodel(index.get(name))
    return metamodel, repo.load_model(name, metamodel)


@router.get("/models/{name}/elements")
def list_elements(
    name: str,
    type: str | None = None,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> list[ElementOut]:
    _, model = _load(name, repo, index)
    items = model.elements.values()
    if type is not None:
        items = [e for e in items if e.type_name == type]
    return [ElementOut.from_core(e) for e in items]


@router.post("/models/{name}/elements", status_code=201)
def create_element(
    name: str,
    payload: CreateElementRequest,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> ElementOut:
    _, model = _load(name, repo, index)
    element = model.create_element(payload.type)
    for key, value in payload.properties.items():
        model.set_property(element, key, value)
    repo.save_model(name, model)
    return ElementOut.from_core(element)


@router.get("/models/{name}/elements/{element_id}")
def get_element(
    name: str,
    element_id: str,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> ElementOut:
    _, model = _load(name, repo, index)
    return ElementOut.from_core(model.get_element(element_id))


@router.patch("/models/{name}/elements/{element_id}")
def update_element(
    name: str,
    element_id: str,
    payload: UpdateElementRequest,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> ElementOut:
    _, model = _load(name, repo, index)
    element = model.get_element(element_id)
    for key, value in payload.properties.items():
        model.set_property(element, key, value)
    repo.save_model(name, model)
    return ElementOut.from_core(element)


@router.delete("/models/{name}/elements/{element_id}", status_code=204)
def delete_element(
    name: str,
    element_id: str,
    repo: FileRepository = Depends(get_repository),
    index: ModelIndex = Depends(get_index),
) -> Response:
    _, model = _load(name, repo, index)
    model.delete_element(element_id)
    repo.save_model(name, model)
    return Response(status_code=204)
