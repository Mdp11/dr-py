from __future__ import annotations

import pytest
from fastapi import HTTPException

from data_rover.api import auth, db, tenancy
from data_rover.api.authz import require_admin
from data_rover.api.db_models import User as UserModel


def _session():
    db.init_engine("sqlite://")
    db.create_all()
    return next(db.get_db())


def test_create_and_get_user_by_email() -> None:
    s = _session()
    u = tenancy.create_user(s, "a@x.com", "pw", is_admin=True)
    assert u.is_admin is True
    assert auth.verify_password("pw", u.password_hash)
    found = tenancy.get_user_by_email(s, "a@x.com")
    assert found is not None
    assert found.id == u.id


def test_create_user_duplicate_email_raises() -> None:
    s = _session()
    tenancy.create_user(s, "a@x.com", "pw", is_admin=False)
    with pytest.raises(ValueError):
        tenancy.create_user(s, "a@x.com", "pw2", is_admin=False)


def test_set_user_fields_and_list_and_delete() -> None:
    s = _session()
    u = tenancy.create_user(s, "a@x.com", "pw", is_admin=False)
    tenancy.set_user_fields(s, u.id, is_admin=True, is_active=False, password="new")
    u2 = tenancy.get_user_by_email(s, "a@x.com")
    assert u2 is not None
    assert u2.is_admin is True and u2.is_active is False
    assert auth.verify_password("new", u2.password_hash)
    assert len(tenancy.list_users(s)) == 1
    assert len(tenancy.list_users(s, q="zzz")) == 0
    tenancy.delete_user(s, u.id)
    assert tenancy.get_user_by_email(s, "a@x.com") is None


def test_require_admin_allows_admin_and_blocks_others() -> None:
    admin = UserModel(id="a", email="a@x", is_admin=True)
    assert require_admin(user=admin) is admin
    normal = UserModel(id="n", email="n@x", is_admin=False)
    with pytest.raises(HTTPException) as ei:
        require_admin(user=normal)
    assert ei.value.status_code == 403
