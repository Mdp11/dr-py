from __future__ import annotations

from fastapi import HTTPException

from data_rover.core.metamodel.schema import Metamodel

from .project_state import ProjectState

__all__ = ["ProjectState", "require_metamodel"]


def require_metamodel(state: ProjectState) -> Metamodel:
    if state.metamodel is None:
        raise HTTPException(status_code=404, detail="No metamodel loaded")
    return state.metamodel
