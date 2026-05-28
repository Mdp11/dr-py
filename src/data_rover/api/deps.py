from __future__ import annotations

from fastapi import HTTPException

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model

from .session import Session, get_session

__all__ = ["Session", "get_session", "require_metamodel", "require_model"]


def require_metamodel(session: Session) -> Metamodel:
    if session.metamodel is None:
        raise HTTPException(status_code=404, detail="No metamodel loaded")
    return session.metamodel


def require_model(session: Session) -> tuple[Metamodel, Model]:
    metamodel = require_metamodel(session)
    if session.model is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    return metamodel, session.model
