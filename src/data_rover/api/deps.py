from __future__ import annotations

from fastapi import HTTPException, Request

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model

from .session import DEFAULT_PROJECT_ID, Session, get_registry, get_session
from .settings import get_settings

__all__ = [
    "Session",
    "get_request_session",
    "get_session",
    "require_allowed_origin",
    "require_metamodel",
    "require_model",
]


def get_request_session(request: Request) -> Session:
    """Resolve the active project's :class:`Session` from the request.

    Phase 1: the project id is taken from the ``X-Project-Id`` header,
    defaulting to ``DEFAULT_PROJECT_ID`` when absent — this preserves the
    behavior of every existing single-project client and the test-suite while
    making the backend able to hold multiple isolated projects at once. Later
    phases replace the header with a ``/projects/{id}`` path segment guarded by
    membership authorization.

    An unknown project id lazily creates a fresh empty session for it (the
    registry's create-on-miss); Phase 2 will gate this on project membership so
    arbitrary header values can no longer spin up sessions. Phase 1 performs no
    eviction, so the registry is bounded only by process lifetime — acceptable
    until membership gating and idle eviction land in later phases.
    """
    project_id = request.headers.get("x-project-id", DEFAULT_PROJECT_ID)
    return get_registry().get(project_id)


def require_allowed_origin(request: Request) -> None:
    """Reject browser-originated cross-site requests (403) — CSRF guard.

    Used on the endpoints that touch the SERVER's local filesystem
    (POST /model/load, /model/save, /model/upload, GET /model/download):
    data-rover's trust model is "localhost single-user tool", but a malicious
    webpage open in the same browser could still fire requests at
    http://127.0.0.1:8000 and read/write the user's files through them. CORS
    only restricts reading responses; it does not stop the request itself.

    Browsers attach an ``Origin`` header to cross-origin requests (and to
    same-origin non-GET ones), and a page cannot forge it. So:

    - ``Origin`` absent → allowed: this is a non-browser client (curl,
      scripts, the test client) or a same-origin GET — outside the CSRF
      threat model.
    - ``Origin`` present and in the configured CORS allowlist (or the
      allowlist contains ``"*"``) → allowed.
    - any other ``Origin`` → 403, request never reaches the handler.
    """
    origin = request.headers.get("origin")
    if origin is None:
        return
    allowed = get_settings().cors_origins
    if "*" in allowed or origin in allowed:
        return
    raise HTTPException(
        status_code=403,
        detail=f"Origin {origin!r} is not allowed to access this endpoint",
    )


def require_metamodel(session: Session) -> Metamodel:
    if session.metamodel is None:
        raise HTTPException(status_code=404, detail="No metamodel loaded")
    return session.metamodel


def require_model(session: Session) -> tuple[Metamodel, Model]:
    metamodel = require_metamodel(session)
    if session.model is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    return metamodel, session.model
