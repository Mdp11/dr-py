from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..deps import Session, get_session, require_model
from ..schemas import CreateElementRequest, ElementOut, UpdateElementRequest

router = APIRouter()


@router.get("/model/elements")
def list_elements(
    type: str | None = None,
    session: Session = Depends(get_session),
) -> list[ElementOut]:
    _, model = require_model(session)
    items = list(model.elements.values())
    if type is not None:
        items = [e for e in items if e.type_name == type]
    return [ElementOut.from_core(e) for e in items]


@router.post("/model/elements", status_code=201)
def create_element(
    payload: CreateElementRequest,
    session: Session = Depends(get_session),
) -> ElementOut:
    _, model = require_model(session)
    element = model.create_element(payload.type)
    for key, value in payload.properties.items():
        model.set_property(element, key, value)
    return ElementOut.from_core(element)


@router.get("/model/elements/{element_id}")
def get_element(
    element_id: str,
    session: Session = Depends(get_session),
) -> ElementOut:
    _, model = require_model(session)
    return ElementOut.from_core(model.get_element(element_id))


@router.patch("/model/elements/{element_id}")
def update_element(
    element_id: str,
    payload: UpdateElementRequest,
    session: Session = Depends(get_session),
) -> ElementOut:
    _, model = require_model(session)
    element = model.get_element(element_id)
    for key, value in payload.properties.items():
        model.set_property(element, key, value)
    return ElementOut.from_core(element)


@router.delete("/model/elements/{element_id}", status_code=204)
def delete_element(
    element_id: str,
    session: Session = Depends(get_session),
) -> Response:
    _, model = require_model(session)
    model.delete_element(element_id)
    return Response(status_code=204)
