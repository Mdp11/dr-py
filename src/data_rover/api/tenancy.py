"""Tenancy service functions over the ORM (no FastAPI here).

Each function takes a live SQLAlchemy ``Session`` and commits its own unit of
work. Routes/dependencies call these instead of writing queries inline.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .auth import hash_password
from .db_models import Membership, Project, Role, User


def upsert_user(db: Session, user_id: str, email: str) -> User:
    """Return the user for *user_id*, creating it (or refreshing its email).

    The check-then-insert is not atomic: under concurrent requests two callers
    can both see "user not found" and both attempt an INSERT. We catch the
    resulting ``IntegrityError`` (UNIQUE violation on ``users.id``), roll back
    the failed insert, and re-fetch the row the winner committed.
    """
    user = db.get(User, user_id)
    if user is None:
        try:
            user = User(id=user_id, email=email)
            db.add(user)
            db.commit()
        except IntegrityError:
            db.rollback()
            user = db.get(User, user_id)
            if user is None:
                raise  # should never happen; re-raise if it does
    if email and user.email != email:
        # no concurrency guard needed here: the row exists and email carries no
        # unique constraint, so this UPDATE can't raise IntegrityError.
        user.email = email
        db.commit()
    return user


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()


def create_user(db: Session, email: str, password: str, is_admin: bool) -> User:
    """Create an admin-provisioned local user. Raises ValueError on duplicate
    email (the route maps it to 409). The id is a fresh uuid (decoupled from the
    email so the email can change without breaking membership rows)."""
    if get_user_by_email(db, email) is not None:
        raise ValueError("email already in use")
    user = User(
        id=uuid.uuid4().hex,
        email=email,
        password_hash=hash_password(password),
        is_admin=is_admin,
    )
    db.add(user)
    db.commit()
    return user


def list_users(db: Session, q: str = "") -> list[User]:
    stmt = select(User).order_by(User.email)
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q}%"))
    return list(db.execute(stmt).scalars())


def set_user_fields(
    db: Session,
    user_id: str,
    *,
    is_admin: bool | None = None,
    is_active: bool | None = None,
    password: str | None = None,
) -> User:
    """Patch any subset of admin-editable fields. Raises ValueError if unknown."""
    user = db.get(User, user_id)
    if user is None:
        raise ValueError("unknown user")
    if is_admin is not None:
        user.is_admin = is_admin
    if is_active is not None:
        user.is_active = is_active
    if password is not None:
        user.password_hash = hash_password(password)
    db.commit()
    return user


def delete_user(db: Session, user_id: str) -> None:
    """Delete a user. Memberships cascade (DB FK); commits keep author_id via
    SET NULL so model history survives the author leaving."""
    user = db.get(User, user_id)
    if user is None:
        return
    db.delete(user)
    db.commit()


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


def list_all_projects(db: Session) -> list[Project]:
    """Every project (admin view). Role is synthesized as owner by the caller."""
    return list(db.execute(select(Project).order_by(Project.name)).scalars())


def list_members(db: Session, project_id: str) -> list[Membership]:
    """All memberships of *project_id* (any role), each with its ``user`` loaded.

    ``selectinload(Membership.user)`` eager-loads the users in one extra query
    so callers reading ``m.user`` don't trigger N+1 lazy loads per member.
    """
    return list(
        db.execute(
            select(Membership)
            .where(Membership.project_id == project_id)
            .options(selectinload(Membership.user))
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
