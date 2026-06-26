"""partial unique index on users.email for non-empty emails

Revision ID: 0007
Revises: 0006
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "uq_users_email_nonempty",
        "users",
        ["email"],
        unique=True,
        postgresql_where=sa.text("email != ''"),
        sqlite_where=sa.text("email != ''"),
    )


def downgrade() -> None:
    op.drop_index("uq_users_email_nonempty", table_name="users")
