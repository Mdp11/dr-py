"""Tenancy service functions over the ORM (no FastAPI here).

Each function takes a live SQLAlchemy ``Session`` and commits its own unit of
work. Routes/dependencies call these instead of writing queries inline.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db_models import Membership, Project, Role, User


def upsert_user(db: Session, user_id: str, email: str) -> User:
    """Return the user for *user_id*, creating it (or refreshing its email)."""
    user = db.get(User, user_id)
    if user is None:
        user = User(id=user_id, email=email)
        db.add(user)
        db.commit()
    elif email and user.email != email:
        user.email = email
        db.commit()
    return user


def create_project(db: Session, name: str, owner_id: str) -> Project:
    """Create a project and make *owner_id* its owner (one unit of work)."""
    project = Project(id=uuid.uuid4().hex, name=name)
    db.add(project)
    db.add(Membership(user_id=owner_id, project_id=project.id, role=Role.owner))
    db.commit()
    return project


def get_membership(db: Session, user_id: str, project_id: str) -> Membership | None:
    """Return the membership joining *user_id* and *project_id*, or ``None``.

    ``None`` means "not a member" — it does NOT distinguish a missing project
    from an existing project the user isn't in; callers that care (authz)
    check project existence separately.
    """
    return db.execute(
        select(Membership).where(
            Membership.user_id == user_id,
            Membership.project_id == project_id,
        )
    ).scalar_one_or_none()


def list_projects_for_user(db: Session, user_id: str) -> list[tuple[Project, Role]]:
    """Projects *user_id* belongs to, each paired with that user's role.

    The role comes from the joined ``Membership`` row, not the ``Project``.
    """
    rows = db.execute(
        select(Project, Membership.role)
        .join(Membership, Membership.project_id == Project.id)
        .where(Membership.user_id == user_id)
    ).all()
    return [(project, role) for project, role in rows]


def list_members(db: Session, project_id: str) -> list[Membership]:
    """All memberships of *project_id* (any role)."""
    return list(
        db.execute(
            select(Membership).where(Membership.project_id == project_id)
        ).scalars()
    )


def add_member(db: Session, project_id: str, user_id: str, role: Role) -> Membership:
    """Add *user_id* to the project with *role*, or update an existing role."""
    m = get_membership(db, user_id, project_id)
    if m is None:
        m = Membership(user_id=user_id, project_id=project_id, role=role)
        db.add(m)
    else:
        m.role = role
    db.commit()
    return m


def _owner_count(db: Session, project_id: str) -> int:
    return db.execute(
        select(func.count()).where(
            Membership.project_id == project_id,
            Membership.role == Role.owner,
        )
    ).scalar_one()


def remove_member(db: Session, project_id: str, user_id: str) -> None:
    """Remove a member. Refuses to remove the last remaining owner.

    The count-then-delete check is not atomic against a concurrent removal;
    serializing project writes (so two owners can't both pass the guard) is a
    Phase 4 concern (the per-project write-mutex). Until then writes are
    effectively single-threaded.
    """
    m = get_membership(db, user_id, project_id)
    if m is None:
        return
    if m.role is Role.owner and _owner_count(db, project_id) <= 1:
        raise ValueError("cannot remove the last owner of a project")
    db.delete(m)
    db.commit()


def delete_project(db: Session, project_id: str) -> None:
    project = db.get(Project, project_id)
    if project is None:
        return
    # Memberships cascade via the DB FK ``ON DELETE CASCADE`` (the parent's
    # ``passive_deletes=True`` relationship trusts the DB). SQLite enforces this
    # because ``init_engine`` enables ``PRAGMA foreign_keys=ON``.
    db.delete(project)
    db.commit()
