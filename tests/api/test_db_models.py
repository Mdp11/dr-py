from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User


def test_create_user_project_membership() -> None:
    gen = db.get_db()
    session = next(gen)
    try:
        session.add(User(id="u1", email="u1@example.com"))
        session.add(Project(id="p1", name="Proj One"))
        session.add(Membership(user_id="u1", project_id="p1", role=Role.owner))
        session.commit()

        m = session.execute(select(Membership)).scalar_one()
        assert m.role is Role.owner
        assert m.user.email == "u1@example.com"
        assert m.project.name == "Proj One"
    finally:
        gen.close()


def test_membership_user_project_unique() -> None:
    gen = db.get_db()
    session = next(gen)
    try:
        session.add(User(id="u1", email=""))
        session.add(Project(id="p1", name="P"))
        session.add(Membership(user_id="u1", project_id="p1", role=Role.editor))
        session.commit()
        session.add(Membership(user_id="u1", project_id="p1", role=Role.viewer))
        with pytest.raises(IntegrityError):
            session.commit()
    finally:
        gen.close()
