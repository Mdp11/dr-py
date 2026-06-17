"""content tables (metamodels, models, views, commits, snapshots)

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "metamodels",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, server_default=""),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("blob", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "models",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "metamodel_id",
            sa.String(),
            sa.ForeignKey("metamodels.id"),
            nullable=False,
        ),
        sa.Column("name", sa.String(), nullable=False, server_default="model"),
        sa.Column("model_rev", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "views",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(), nullable=False, server_default=""),
        sa.Column("blob", sa.Text(), nullable=False),
    )
    op.create_table(
        "commits",
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("rev", sa.Integer(), primary_key=True),
        sa.Column("commit_id", sa.String(), nullable=False),
        sa.Column(
            "author_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ops", sa.JSON(), nullable=False),
        sa.Column("inverse_ops", sa.JSON(), nullable=False),
        sa.Column("id_map", sa.JSON(), nullable=False),
    )
    op.create_table(
        "snapshots",
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("rev", sa.Integer(), primary_key=True),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("snapshots")
    op.drop_table("commits")
    op.drop_table("views")
    op.drop_table("models")
    op.drop_table("metamodels")
