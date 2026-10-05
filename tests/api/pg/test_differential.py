"""The commit differential, on Postgres: the same seeds, the same oracle, the
same assertions, through the lane's engine and schema."""

from __future__ import annotations

from ..test_commit_differential import (  # noqa: F401  (collected here, run on Postgres)
    client,
    test_a_commit_on_head_rows_equals_the_full_model,
)
