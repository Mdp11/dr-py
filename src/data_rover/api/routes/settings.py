"""Project settings — the strict-mode policy toggle.

GET is readable by any member; PATCH is owner-only (mirrors membership
management). The flag is written to the durable ``ModelRow.validation_policy``
AND the live in-memory ``ProjectState`` under the project write-mutex, so a policy
change cannot interleave inconsistently with a concurrent commit.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from sqlalchemy.orm import Session as DbSession

from .. import content
from ..authz import require_membership, require_owner
from ..db import get_db
from ..project_state import ProjectState, get_project_state

router = APIRouter()


class ProjectSettings(BaseModel):
    strict_mode: bool


@router.get("/settings", response_model=ProjectSettings)
def read_settings(
    state: ProjectState = Depends(get_project_state),
    _member=Depends(require_membership),
) -> ProjectSettings:
    return ProjectSettings(strict_mode=state.strict_mode)


@router.patch("/settings", response_model=ProjectSettings)
def update_settings(
    body: ProjectSettings,
    project_id: str,
    state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
    _owner=Depends(require_owner),
) -> ProjectSettings:
    with state.write_mutex:
        try:
            content.set_strict_mode(db, project_id, body.strict_mode)
        except LookupError as exc:
            raise HTTPException(
                status_code=409, detail="project has no model; upload one first"
            ) from exc
        state.strict_mode = body.strict_mode
    return ProjectSettings(strict_mode=state.strict_mode)
