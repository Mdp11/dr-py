"""commit metadata: message, validation_error_count, issues

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "commits",
        sa.Column("message", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "commits",
        sa.Column(
            "validation_error_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "commits",
        sa.Column(
            "issues", sa.JSON(), nullable=False, server_default="[]"
        ),
    )


def downgrade() -> None:
    op.drop_column("commits", "issues")
    op.drop_column("commits", "validation_error_count")
    op.drop_column("commits", "message")
