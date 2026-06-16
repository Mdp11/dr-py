from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

# Force every API test onto an in-memory SQLite db and disable the dev seed
# BEFORE any app/settings import reads the environment.
os.environ.setdefault("DATA_ROVER_DATABASE_URL", "sqlite://")
os.environ.setdefault("DATA_ROVER_DEV_SEED", "false")

from data_rover.api import db  # noqa: E402
from data_rover.api import db_models  # noqa: E402,F401  (registers ORM tables)
from data_rover.api.session import reset_session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db() -> Iterator[None]:
    """Per-test clean schema + clean in-memory session registry."""
    db.init_engine("sqlite://")
    db.create_all()
    reset_session()
    try:
        yield
    finally:
        db.drop_all()
        reset_session()
