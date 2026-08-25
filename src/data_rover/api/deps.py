from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model

from .authz import require_membership
from .db_models import Membership
from .session import Session, get_registry
from .settings import get_settings

__all__ = [
    "Session",
    "get_request_session",
    "read_capped_body",
    "require_allowed_origin",
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


def _too_large(limit: int) -> HTTPException:
    return HTTPException(
        status_code=413,
        detail=f"Request body is too large (limit {limit} bytes)",
    )


async def read_capped_body(request: Request) -> bytes:
    """Buffer the whole raw request body, refusing an oversized one with 413.

    The single guard for the routes that read an unbounded body and parse it
    whole (POST /model/upload, POST /model/compare). The cap is
    ``settings.max_request_body_bytes``; 0 disables it.

    A ``Content-Length`` over the cap is refused before a byte is read, but
    the header is client-supplied and absent on a chunked body, so the
    running total is enforced while streaming too — the header is the cheap
    path, never the guarantee. 413 (not the routes' 422) so a client can
    tell an oversized body from a malformed one.
    """
    limit = get_settings().max_request_body_bytes
    if limit <= 0:
        return await request.body()
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise _too_large(limit)
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise _too_large(limit)
        chunks.append(chunk)
    return b"".join(chunks)


def require_metamodel(session: Session) -> Metamodel:
    if session.metamodel is None:
        raise HTTPException(status_code=404, detail="No metamodel loaded")
    return session.metamodel


def require_model(session: Session) -> tuple[Metamodel, Model]:
    metamodel = require_metamodel(session)
    if session.model is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    return metamodel, session.model
