"""model validation_policy (strict mode)

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "models",
        sa.Column("validation_policy", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("models", "validation_policy")
