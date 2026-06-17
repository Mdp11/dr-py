"""initial tenancy schema

Revision ID: 0001
Revises:
Create Date: 2026-06-17
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        # no server_default: the "" default is ORM-level only, matching the
        # db_models.User.email model (avoids Alembic autogenerate drift).
        sa.Column("email", sa.String(), nullable=False),
    )
    op.create_table(
        "projects",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
    )
    op.create_table(
        "memberships",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "role",
            sa.Enum("owner", "editor", "viewer", name="role", native_enum=False),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "user_id", "project_id", name="uq_membership_user_project"
        ),
    )


def downgrade() -> None:
    op.drop_table("memberships")
    op.drop_table("projects")
    op.drop_table("users")
