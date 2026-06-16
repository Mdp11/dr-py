from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..deps import Session, get_request_session, require_model
from ..schemas import CreateElementRequest, ElementOut, UpdateElementRequest

router = APIRouter()


# NOTE: GET /model/elements (paged listing + search) lives in routes/read.py
# since Phase C2-read; this module keeps the legacy mutation endpoints and the
# single-element GET.


@router.post("/model/elements", status_code=201)
def create_element(
    payload: CreateElementRequest,
    session: Session = Depends(get_request_session),
) -> ElementOut:
    _, model = require_model(session)
    element = model.create_element(payload.type)
    try:
        for key, value in payload.properties.items():
            model.set_property(element, key, value)
    finally:
        # legacy route mutates outside the ops protocol (even when a property
        # fails after the element was created): invalidate rev/op-log state
        session.touch_model()
    return ElementOut.from_core(element)


@router.get("/model/elements/{element_id}")
def get_element(
    element_id: str,
    session: Session = Depends(get_request_session),
) -> ElementOut:
    _, model = require_model(session)
    return ElementOut.from_core(model.get_element(element_id))


@router.patch("/model/elements/{element_id}")
def update_element(
    element_id: str,
    payload: UpdateElementRequest,
    session: Session = Depends(get_request_session),
) -> ElementOut:
    _, model = require_model(session)
    element = model.get_element(element_id)
    try:
        for key, value in payload.properties.items():
            model.set_property(element, key, value)
    finally:
        # see create_element: mutation outside the ops protocol
        session.touch_model()
    return ElementOut.from_core(element)


@router.delete("/model/elements/{element_id}", status_code=204)
def delete_element(
    element_id: str,
    session: Session = Depends(get_request_session),
) -> Response:
    _, model = require_model(session)
    model.delete_element(element_id)
    session.touch_model()  # mutation outside the ops protocol
    return Response(status_code=204)
