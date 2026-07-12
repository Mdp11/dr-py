"""Authorization: gate project-scoped requests on membership + role.

``require_membership`` resolves the ``project_id`` path param, confirms the
project exists (404) and the current user is a member (403 — except global
admins, who get implicit owner access to every project), and rejects writes
by viewers (403). ``require_owner`` further restricts to owners (membership
management). These are wired into every project-scoped route transitively via
``deps.get_request_session`` (Task 8), so route handlers need no changes.

Write detection is by HTTP method, with an allowlist of POST endpoints that are
actually reads (search / batch fetch / validate) so viewers can use them.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from .db_models import Membership, Project, Role, User
from .identity import get_current_user
from .tenancy import get_membership

_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: POST endpoints that only READ the model (no mutation), so a viewer must be
#: allowed to call them. Matched by path SUFFIX against the request URL.
#:
#: Maintenance contract (both directions):
#:   - A new read-only POST endpoint MUST be added here, or viewers get a
#:     spurious 403.
#:   - No future *write* POST may end with one of these suffixes, or it would
#:     be silently exempted from the viewer-write check (privilege hole).
#:
#: Deliberately NOT included: ``POST /model/save`` — it writes to the SERVER's
#: filesystem (a privileged side effect), so it stays a "write" even though it
#: doesn't mutate the in-memory model. Viewers cannot export to server disk.
#: Also NOT included: ``POST /model/apply-cr`` — it is dual-mode (inline =
#: read, session = mutate) and a path suffix can't tell the modes apart, so it
#: is conservatively treated as a write; viewers can't use the CR tool.
#:
#: ``/clone`` (``POST /projects/{id}/clone``) only READS the source project —
#: it creates a brand-new project owned by the caller and never mutates the
#: source, so a viewer of the source may clone it.
_READ_ONLY_POST_SUFFIXES = (
    "/model/search",
    "/model/elements/batch",
    "/model/elements/tree-items",
    "/model/validate",
    "/commits/preview",
    "/metamodel/diff",
    "/clone",
    "/navigations/evaluate",
    "/tables/evaluate",
    "/tables/export",
)


def _is_write(request: Request) -> bool:
    if request.method not in _WRITE_METHODS:
        return False
    if request.method == "POST" and request.url.path.endswith(_READ_ONLY_POST_SUFFIXES):
        return False
    return True


def require_membership(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Membership:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    membership = get_membership(db, user.id, project_id)
    if membership is None:
        # Global admins have implicit owner access to EVERY project so they can
        # open/manage any project without an explicit membership row. This is a
        # transient in-memory Membership (never added to the DB session); it
        # carries the owner role through the request so the viewer-write guard
        # below is naturally satisfied.
        if user.is_admin:
            return Membership(user_id=user.id, project_id=project_id, role=Role.owner)
        raise HTTPException(status_code=403, detail="not a project member")
    if _is_write(request) and membership.role is Role.viewer:
        raise HTTPException(
            status_code=403, detail="viewer role cannot modify the model"
        )
    return membership


def require_owner(
    membership: Membership = Depends(require_membership),
) -> Membership:
    if membership.role is not Role.owner:
        raise HTTPException(status_code=403, detail="owner role required")
    return membership


def require_admin(user: User = Depends(get_current_user)) -> User:
    """Gate a route on the global ``is_admin`` flag (system-level permission:
    user management, all-project membership management, project creation).
    Distinct from ``require_owner``, which is a per-project role check."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin privileges required")
    return user
