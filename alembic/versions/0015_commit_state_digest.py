"""commits.state_digest — the state digest of the model after each commit

Revision ID: 0015
Revises: 0014
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("commits", sa.Column("state_digest", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("commits", "state_digest")
