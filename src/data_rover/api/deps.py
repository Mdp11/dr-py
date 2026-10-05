from __future__ import annotations

from fastapi import Depends, HTTPException

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model

from .authz import require_membership
from .db_models import Membership
from .session import Session, get_registry

__all__ = [
    "Session",
    "get_request_session",
    "require_metamodel",
    "require_model",
]


def get_request_session(
    project_id: str,
    _membership: Membership = Depends(require_membership),
) -> Session:
    """Resolve the live in-memory :class:`Session` for the path's project.

    ``project_id`` comes from the ``/api/v1/projects/{project_id}`` path
    segment. ``require_membership`` runs first (it transitively resolves the
    identity + DB and checks the project exists and the caller is a member with
    a sufficient role), so by the time this body runs the access is authorized:
    unknown project -> 404, non-member -> 403, viewer writing -> 403, all raised
    before we touch the registry.
    """
    return get_registry().get(project_id)


def require_metamodel(session: Session) -> Metamodel:
    if session.metamodel is None:
        raise HTTPException(status_code=404, detail="No metamodel loaded")
    return session.metamodel


def require_model(session: Session) -> tuple[Metamodel, Model]:
    metamodel = require_metamodel(session)
    if session.model is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    return metamodel, session.model
