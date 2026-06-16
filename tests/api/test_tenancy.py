from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy.orm import Session

from data_rover.api import db, tenancy
from data_rover.api.db_models import Project, Role


@pytest.fixture
def session() -> Iterator[Session]:
    gen = db.get_db()
    s = next(gen)
    try:
        yield s
    finally:
        gen.close()


def test_upsert_user_creates_then_updates_email(session) -> None:
    u = tenancy.upsert_user(session, "u1", "a@x.com")
    assert u.email == "a@x.com"
    u2 = tenancy.upsert_user(session, "u1", "b@x.com")
    assert u2.id == "u1"
    assert u2.email == "b@x.com"


def test_create_project_makes_creator_owner(session) -> None:
    tenancy.upsert_user(session, "u1", "")
    p = tenancy.create_project(session, "My Project", "u1")
    assert p.name == "My Project"
    m = tenancy.get_membership(session, "u1", p.id)
    assert m is not None and m.role is Role.owner


def test_get_membership_none_for_non_member(session) -> None:
    tenancy.upsert_user(session, "u1", "")
    tenancy.upsert_user(session, "u2", "")
    p = tenancy.create_project(session, "P", "u1")
    assert tenancy.get_membership(session, "u2", p.id) is None


def test_list_projects_for_user(session) -> None:
    tenancy.upsert_user(session, "u1", "")
    a = tenancy.create_project(session, "A", "u1")
    b = tenancy.create_project(session, "B", "u1")
    got = {p.id for p, _role in tenancy.list_projects_for_user(session, "u1")}
    assert got == {a.id, b.id}


def test_add_update_remove_member(session) -> None:
    tenancy.upsert_user(session, "owner", "")
    tenancy.upsert_user(session, "u2", "")
    p = tenancy.create_project(session, "P", "owner")

    m = tenancy.add_member(session, p.id, "u2", Role.viewer)
    assert m.role is Role.viewer
    m2 = tenancy.add_member(session, p.id, "u2", Role.editor)  # upsert
    assert m2.role is Role.editor

    tenancy.remove_member(session, p.id, "u2")
    assert tenancy.get_membership(session, "u2", p.id) is None


def test_cannot_remove_last_owner(session) -> None:
    tenancy.upsert_user(session, "owner", "")
    p = tenancy.create_project(session, "P", "owner")
    with pytest.raises(ValueError):
        tenancy.remove_member(session, p.id, "owner")


def test_delete_project_cascades(session) -> None:
    tenancy.upsert_user(session, "owner", "")
    p = tenancy.create_project(session, "P", "owner")
    tenancy.delete_project(session, p.id)
    assert session.get(Project, p.id) is None
    assert tenancy.get_membership(session, "owner", p.id) is None
