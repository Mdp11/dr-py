"""snapshots: the blob header's fields (format, metamodel_id, state_digest, counts)

Revision ID: 0016
Revises: 0015
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("snapshots", sa.Column("format", sa.String(8), nullable=True))
    op.add_column("snapshots", sa.Column("metamodel_id", sa.String(), nullable=True))
    op.add_column("snapshots", sa.Column("state_digest", sa.String(16), nullable=True))
    op.add_column("snapshots", sa.Column("elements", sa.Integer(), nullable=True))
    op.add_column("snapshots", sa.Column("relationships", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("snapshots", "relationships")
    op.drop_column("snapshots", "elements")
    op.drop_column("snapshots", "state_digest")
    op.drop_column("snapshots", "metamodel_id")
    op.drop_column("snapshots", "format")
