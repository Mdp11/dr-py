"""GET /metamodel/layout — shared metamodel-canvas positions.

Deliberately does NOT depend on ``get_request_session``: reading a layout
must not hydrate a cold project's model. Membership is enforced directly by
``authz.require_membership`` (method-based: any member GETs). No lease, no
journal — presentation only (spec 2026-08-13 §5/§6): layout is last-write-wins
because a lost drag is re-dragged, unlike model content where a lost write is
corruption.

The write side used to be a standalone ``PUT`` here; it is now the
``metamodel.move_node`` op under ``POST /commits`` (``content.
stage_metamodel_layout``, ``metamodel_ops.py``), which persists to the same
``MetamodelLayoutRow`` this route reads — the standalone ``PUT`` was retired
with no legacy window (spec 2026-08-16, Task 9).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from .. import content
from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership

router = APIRouter()


class LayoutPosition(BaseModel):
    x: float
    y: float


class MetamodelLayoutPayload(BaseModel):
    positions: dict[str, LayoutPosition] = Field(default_factory=dict)


@router.get("/metamodel/layout", response_model=MetamodelLayoutPayload)
def get_metamodel_layout(
    project_id: str,
    db: DbSession = Depends(get_db),
    _membership: Membership = Depends(require_membership),
) -> MetamodelLayoutPayload:
    blob = content.get_metamodel_layout(db, project_id)
    if blob is None:
        return MetamodelLayoutPayload()
    return MetamodelLayoutPayload.model_validate(blob)
