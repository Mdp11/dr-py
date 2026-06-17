from __future__ import annotations

from sqlalchemy import text

from data_rover.api import db


def test_init_engine_is_idempotent_for_same_url() -> None:
    e1 = db.init_engine("sqlite://")
    e2 = db.init_engine("sqlite://")
    assert e1 is e2


def test_init_engine_force_rebuilds() -> None:
    e1 = db.init_engine("sqlite://")
    e2 = db.init_engine("sqlite://", force=True)
    assert e1 is not e2


def test_get_db_yields_usable_session() -> None:
    db.init_engine("sqlite://", force=True)
    gen = db.get_db()
    session = next(gen)
    try:
        assert session.execute(text("SELECT 1")).scalar() == 1
    finally:
        gen.close()  # Generator.close() is available since get_db returns a Generator
