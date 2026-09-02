"""views — unique (project_id, name)

Revision ID: 0014
Revises: 0013
"""

from __future__ import annotations

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # a unique INDEX rather than a table constraint: SQLite cannot ALTER a
    # constraint in, and the index is what both backends enforce anyway.
    op.create_index(
        "uq_views_project_name", "views", ["project_id", "name"], unique=True
    )


def downgrade() -> None:
    op.drop_index("uq_views_project_name", table_name="views")
