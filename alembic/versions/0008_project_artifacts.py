"""project_artifacts table (Stage 1 navigation artifacts)

Revision ID: 0008
Revises: 0007
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_artifacts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "kind",
            sa.Enum(
                "navigation", "table", "diagram", "diagram_kind",
                name="artifact_kind", native_enum=False,
            ),
            nullable=False,
        ),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("artifact_rev", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_by",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "project_id", "kind", "name", name="uq_artifact_project_kind_name"
        ),
    )


def downgrade() -> None:
    op.drop_table("project_artifacts")
