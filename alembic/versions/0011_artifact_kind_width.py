"""Widen project_artifacts.kind for custom_export.

`SAEnum(..., native_enum=False)` (0008) emitted a plain VARCHAR sized to the
then-longest member — VARCHAR(12) — with NO CHECK constraint
(`create_constraint` defaults to False). "custom_export" is 13 chars, so
Postgres needs the widen; 32 leaves headroom for future kinds. SQLite is
untyped-length and unaffected (tests use create_all anyway).

Revision ID: 0011
Revises: 0010
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # batch mode: SQLite can't ALTER COLUMN TYPE in place (tests run this
    # migration for real, unlike Postgres where batch is a no-op wrapper).
    with op.batch_alter_table("project_artifacts") as batch:
        batch.alter_column(
            "kind",
            existing_type=sa.VARCHAR(length=12),
            type_=sa.VARCHAR(length=32),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("project_artifacts") as batch:
        batch.alter_column(
            "kind",
            existing_type=sa.VARCHAR(length=32),
            type_=sa.VARCHAR(length=12),
            existing_nullable=False,
        )
