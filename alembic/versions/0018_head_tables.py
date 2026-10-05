"""head tables (elements, relationships, entity_refs) and the model row's head columns

Revision ID: 0018
Revises: 0017
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def _project_fk() -> sa.ForeignKey:
    return sa.ForeignKey("projects.id", ondelete="CASCADE")


def upgrade() -> None:
    op.create_table(
        "elements",
        sa.Column("project_id", sa.String(), _project_fk(), primary_key=True),
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("type_name", sa.String(), nullable=False),
        sa.Column("properties", sa.Text(), nullable=False),
        sa.Column("rev", sa.Integer(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("project_id", "seq"),
    )
    op.create_table(
        "relationships",
        sa.Column("project_id", sa.String(), _project_fk(), primary_key=True),
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("type_name", sa.String(), nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("target_id", sa.String(), nullable=False),
        sa.Column("properties", sa.Text(), nullable=False),
        sa.Column("rev", sa.Integer(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("project_id", "seq"),
    )
    op.create_index("ix_rel_source", "relationships", ["project_id", "source_id"])
    op.create_index("ix_rel_target", "relationships", ["project_id", "target_id"])
    op.create_table(
        "entity_refs",
        sa.Column("project_id", sa.String(), _project_fk(), primary_key=True),
        sa.Column("referencer_id", sa.String(), primary_key=True),
        sa.Column("target_id", sa.String(), primary_key=True),
    )
    op.create_index("ix_refs_target", "entity_refs", ["project_id", "target_id"])
    with op.batch_alter_table("models") as batch:
        batch.add_column(sa.Column("state_digest", sa.String(16), nullable=True))
        batch.add_column(
            sa.Column("element_count", sa.Integer(), nullable=False, server_default="0")
        )
        batch.add_column(
            sa.Column(
                "relationship_count", sa.Integer(), nullable=False, server_default="0"
            )
        )
        batch.add_column(sa.Column("next_seq", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("models") as batch:
        batch.drop_column("next_seq")
        batch.drop_column("relationship_count")
        batch.drop_column("element_count")
        batch.drop_column("state_digest")
    op.drop_index("ix_refs_target", table_name="entity_refs")
    op.drop_table("entity_refs")
    op.drop_index("ix_rel_target", table_name="relationships")
    op.drop_index("ix_rel_source", table_name="relationships")
    op.drop_table("relationships")
    op.drop_table("elements")
