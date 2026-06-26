from __future__ import annotations

from data_rover.api import db
from data_rover.api.db_models import User


def test_user_has_auth_columns() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="u1", email="u1@x", password_hash="h", is_admin=True))
        s.commit()
        u = s.get(User, "u1")
        assert u is not None
        assert u.password_hash == "h"
        assert u.is_admin is True
        assert u.is_active is True  # default
    finally:
        gen.close()
