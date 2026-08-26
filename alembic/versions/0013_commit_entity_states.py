"""commits.entity_states — per-commit touched-entity before/after state

Revision ID: 0013
Revises: 0012
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("commits", sa.Column("entity_states", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("commits", "entity_states")
