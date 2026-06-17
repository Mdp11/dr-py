"""Tenancy ORM models: who exists, what projects exist, who can touch them.

These rows are the authorization source of truth. They are deliberately small
— the model/metamodel/view data is NOT stored here in Phase 2 (durable model
persistence is Phase 3); the in-memory ``Session`` still holds it. A ``User``'s
``id`` is the external identity subject (from the IdentityProvider), so a real
SSO swap reuses the same primary key space.
"""

from __future__ import annotations

import enum

from sqlalchemy import Enum as SAEnum
from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class Role(str, enum.Enum):
    """Project role. ``owner`` manages membership; ``editor`` writes the model;
    ``viewer`` is read-only (write attempts are rejected 403 in ``authz``)."""

    owner = "owner"
    editor = "editor"
    viewer = "viewer"


class User(Base):
    """A person who can be granted access to projects.

    The PK is the external identity subject id (see module docstring), so users
    are auto-provisioned on first sight by the identity layer without a separate
    id space to reconcile.
    """

    __tablename__ = "users"

    #: external identity subject id (stable across logins)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    #: may be blank (e.g. an SSO subject with no email claim); stored as ""
    #: rather than NULL to keep queries null-free. The default is ORM-level
    #: only — raw-SQL inserts must supply "" themselves (no server_default).
    email: Mapped[str] = mapped_column(String, default="", nullable=False)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        # children are removed by the DB FK ``ondelete="CASCADE"``; skip the
        # ORM's load-then-delete-each-row pass (see Membership FKs below).
        passive_deletes=True,
    )


class Project(Base):
    """One project = one model + N views (Phase 3). Ownership is per-project.

    The ``id`` is caller-supplied (the tenancy service generates a uuid; tests
    and the dev-seed pin stable ids), not autoincremented, so it is stable in
    URLs (``/api/v1/projects/{id}``).
    """

    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,  # DB FK ondelete="CASCADE" handles children
    )


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("user_id", "project_id", name="uq_membership_user_project"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    #: ``native_enum=False`` stores the value as VARCHAR + CHECK on every
    #: backend (a plain string in SQLite tests), avoiding a process-global
    #: Postgres ENUM type whose lifecycle Alembic handles awkwardly.
    role: Mapped[Role] = mapped_column(
        SAEnum(Role, name="role", native_enum=False), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="memberships")
    project: Mapped[Project] = relationship(back_populates="memberships")
