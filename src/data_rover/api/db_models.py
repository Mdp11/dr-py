"""Tenancy ORM models: who exists, what projects exist, who can touch them.

These rows are the authorization source of truth. They are deliberately small
— the model/metamodel/view data is NOT stored here in Phase 2 (durable model
persistence is Phase 3); the in-memory ``Session`` still holds it. A ``User``'s
``id`` is the external identity subject (from the IdentityProvider), so a real
SSO swap reuses the same primary key space.
"""

from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy import Enum as SAEnum
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
    __table_args__ = (
        # Login email must be unique, but many users carry the "" sentinel
        # (header/importer/dev users with no email claim) — so uniqueness is
        # PARTIAL, enforced only for non-empty emails.
        Index(
            "uq_users_email_nonempty",
            "email",
            unique=True,
            sqlite_where=text("email != ''"),
            postgresql_where=text("email != ''"),
        ),
    )

    #: external identity subject id (stable across logins)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    #: may be blank (e.g. an SSO subject with no email claim); stored as ""
    #: rather than NULL to keep queries null-free. The default is ORM-level
    #: only — raw-SQL inserts must supply "" themselves (no server_default).
    email: Mapped[str] = mapped_column(String, default="", nullable=False)
    #: Argon2id hash of the local password. NULL for users that authenticate
    #: only via a future SSO provider (no local credential). The cookie auth
    #: path rejects a NULL-hash user at login.
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Global role. The single system-level permission (see authz.require_admin):
    #: admins manage users, all project memberships, and create projects.
    is_admin: Mapped[bool] = mapped_column(default=False, nullable=False)
    #: Deactivation = revocation. An inactive user is rejected 401 on the next
    #: request even with a still-valid JWT (identity layer re-checks per request).
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)

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


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MetamodelRow(Base):
    """A versioned, shareable metamodel. ``blob`` is the YAML source text
    (re-parsed via ``load_metamodel_str`` on hydrate). Immutable per version:
    a new metamodel is a new row, never an in-place mutation (Phase 6)."""

    __tablename__ = "metamodels"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    blob: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class ModelRow(Base):
    """One project's model. 1:1 with ``Project`` (unique project_id). Carries
    the DB-authoritative ``model_rev`` and the swappable ``metamodel_id``."""

    __tablename__ = "models"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    metamodel_id: Mapped[str] = mapped_column(
        ForeignKey("metamodels.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False, default="model")
    model_rev: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Per-project validation policy (strict-mode feature). JSON so it can grow
    #: into per-category promotion flags without a schema migration. v1 shape:
    #: ``{"strict": bool}``. NULL / missing key reads as strict=false (the
    #: inspectable default).
    validation_policy: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    #: Declared so SQLAlchemy's unit-of-work can order INSERTs correctly (it
    #: resolves FK dependencies via relationship edges, not FK columns alone).
    metamodel: Mapped[MetamodelRow] = relationship()
    project: Mapped[Project] = relationship()


class ViewRow(Base):
    """A user-defined folder overlay. ``blob`` is the view JSON
    (``View.model_dump_json``). N per project (Phase 3 frontend uses one)."""

    __tablename__ = "views"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    blob: Mapped[str] = mapped_column(Text, nullable=False)


class Commit(Base):
    """One accepted ops batch == one revision == one journal row (spec §7).

    ``ops``/``inverse_ops`` are the canonical op lists in the same format as
    ``frontend/.../ops.ts`` (serialized via ``schemas.OPS_ADAPTER``);
    ``inverse_ops`` are stored in execution order so undo/replay is "apply
    front-to-back". ``author_id`` is SET NULL on user delete so history
    survives the author leaving."""

    __tablename__ = "commits"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    rev: Mapped[int] = mapped_column(Integer, primary_key=True)
    commit_id: Mapped[str] = mapped_column(String, nullable=False)
    author_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    ops: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    inverse_ops: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    id_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    #: optional human commit message (spec §7). Empty for the legacy
    #: /model/ops + /model/undo paths (they pass no message).
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    #: number of CONFORMANCE-tier issues over the dirty set at commit time
    #: (structural issues are hard-rejected, so this counts only soft ones).
    validation_error_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    #: the conformance issue list recorded at commit (IssueOut dicts).
    issues: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    #: metamodel rebind (Phase 6B): the model's metamodel_id before/after this
    #: commit. Both NULL for ordinary edit commits; set only by /metamodel/rebind.
    #: SET NULL on metamodel delete so history survives a retired metamodel.
    from_metamodel_id: Mapped[str | None] = mapped_column(
        ForeignKey("metamodels.id", ondelete="SET NULL"), nullable=True
    )
    to_metamodel_id: Mapped[str | None] = mapped_column(
        ForeignKey("metamodels.id", ondelete="SET NULL"), nullable=True
    )

    #: Declared so the ORM unit-of-work can order INSERTs correctly.
    project: Mapped[Project] = relationship()


class Snapshot(Base):
    """A full-model snapshot in the SnapshotStore. Hydration loads the
    nearest snapshot with ``rev <= model_rev`` then replays later commits."""

    __tablename__ = "snapshots"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    rev: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String, nullable=False)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class ArtifactKind(str, enum.Enum):
    """Kinds of project artifacts. All four mega-plan kinds are declared up
    front (the column is VARCHAR+CHECK, so this costs nothing); Stage 1 only
    accepts `navigation` payloads at the route layer."""

    navigation = "navigation"
    table = "table"
    diagram = "diagram"
    diagram_kind = "diagram_kind"


class ArtifactRow(Base):
    """A project-shared, model-external artifact (saved navigation, table,
    diagram...). `payload` is the kind-specific JSON document, validated at
    the route layer; it is NEVER part of the model or the op journal.
    `artifact_rev` is the optimistic-concurrency counter: writers echo the
    rev they loaded and a mismatch is a 409 (no leases — artifact edits never
    touch the model)."""

    __tablename__ = "project_artifacts"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "kind", "name", name="uq_artifact_project_kind_name"
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[ArtifactKind] = mapped_column(
        SAEnum(ArtifactKind, name="artifact_kind", native_enum=False),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    artifact_rev: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )
    #: SET NULL so artifacts survive their last editor's account deletion.
    updated_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
