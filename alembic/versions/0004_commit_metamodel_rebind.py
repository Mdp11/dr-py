"""commit metamodel rebind columns: from_metamodel_id, to_metamodel_id

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("commits") as batch:
        batch.add_column(sa.Column("from_metamodel_id", sa.String(), nullable=True))
        batch.add_column(sa.Column("to_metamodel_id", sa.String(), nullable=True))
        batch.create_foreign_key(
            "fk_commits_from_metamodel_id", "metamodels",
            ["from_metamodel_id"], ["id"], ondelete="SET NULL",
        )
        batch.create_foreign_key(
            "fk_commits_to_metamodel_id", "metamodels",
            ["to_metamodel_id"], ["id"], ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("commits") as batch:
        batch.drop_constraint("fk_commits_to_metamodel_id", type_="foreignkey")
        batch.drop_constraint("fk_commits_from_metamodel_id", type_="foreignkey")
        batch.drop_column("to_metamodel_id")
        batch.drop_column("from_metamodel_id")
