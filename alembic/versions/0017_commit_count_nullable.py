"""commits.validation_error_count nullable (a revert has no reported count)

Revision ID: 0017
Revises: 0016
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("commits") as batch:
        batch.alter_column(
            "validation_error_count", existing_type=sa.Integer(), nullable=True
        )


def downgrade() -> None:
    op.execute("UPDATE commits SET validation_error_count = 0 WHERE validation_error_count IS NULL")
    with op.batch_alter_table("commits") as batch:
        batch.alter_column(
            "validation_error_count", existing_type=sa.Integer(), nullable=False
        )
