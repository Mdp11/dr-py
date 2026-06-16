from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..deps import Session, get_request_session, require_model
from ..schemas import CreateRelationshipRequest, RelationshipOut

router = APIRouter()


@router.get("/model/relationships")
def list_relationships(
    type: str | None = None,
    source_id: str | None = None,
    target_id: str | None = None,
    session: Session = Depends(get_request_session),
) -> list[RelationshipOut]:
    _, model = require_model(session)
    items = list(model.relationships.values())
    if type is not None:
        items = [r for r in items if r.type_name == type]
    if source_id is not None:
        items = [r for r in items if r.source_id == source_id]
    if target_id is not None:
        items = [r for r in items if r.target_id == target_id]
    return [RelationshipOut.from_core(r) for r in items]


@router.post("/model/relationships", status_code=201)
def create_relationship(
    payload: CreateRelationshipRequest,
    session: Session = Depends(get_request_session),
) -> RelationshipOut:
    _, model = require_model(session)
    rel = model.connect(payload.type, payload.source_id, payload.target_id)
    session.touch_model()  # mutation outside the ops protocol
    return RelationshipOut.from_core(rel)


@router.delete("/model/relationships/{relationship_id}", status_code=204)
def delete_relationship(
    relationship_id: str,
    session: Session = Depends(get_request_session),
) -> Response:
    _, model = require_model(session)
    model.disconnect(relationship_id)
    session.touch_model()  # mutation outside the ops protocol
    return Response(status_code=204)
