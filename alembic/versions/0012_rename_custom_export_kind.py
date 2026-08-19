"""Rename artifact kind 'custom_export' -> 'exporter' (data only).

The `project_artifacts.kind` column is a bare VARCHAR (native_enum=False and
therefore no CHECK constraint -- see db_models.ArtifactKind's docstring), so
the rename needs no schema change: only stored rows carry the old literal,
and a row holding it would fail the StrEnum lookup at read time.
"""

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

_UP = "UPDATE project_artifacts SET kind = 'exporter' WHERE kind = 'custom_export'"
_DOWN = "UPDATE project_artifacts SET kind = 'custom_export' WHERE kind = 'exporter'"


def upgrade() -> None:
    op.execute(_UP)


def downgrade() -> None:
    op.execute(_DOWN)
