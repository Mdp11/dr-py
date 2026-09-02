from __future__ import annotations

import pytest

from data_rover.api import content
from data_rover.api.content import DuplicateViewNameError
from data_rover.api.db import db_session

from .conftest import seed_default_project

BLOB = '{"name":"x","folders":[],"artifacts":[]}'


def test_create_list_get_delete() -> None:
    seed_default_project()
    with db_session() as db:
        b = content.create_view(db, "default", name="Beta", blob=BLOB)
        a = content.create_view(db, "default", name="Alpha", blob=BLOB)
        assert [r.name for r in content.list_views(db, "default")] == ["Alpha", "Beta"]
        assert a.view_rev == 0
        assert content.get_view(db, "default", b.id) is b
        assert content.get_view(db, "other", b.id) is None
        assert content.delete_view(db, "default", b.id) is True
        assert content.delete_view(db, "default", b.id) is False
        assert [r.id for r in content.list_views(db, "default")] == [a.id]


def test_duplicate_name_refused() -> None:
    seed_default_project()
    with db_session() as db:
        content.create_view(db, "default", name="Ops", blob=BLOB)
        with pytest.raises(DuplicateViewNameError):
            content.create_view(db, "default", name="Ops", blob=BLOB)


def test_upsert_bumps_rev_only_when_asked() -> None:
    seed_default_project()
    with db_session() as db:
        row = content.create_view(db, "default", name="Ops", blob=BLOB)
        content.upsert_view(db, "default", row.id, blob=BLOB, bump_rev=False)
        assert row.view_rev == 0
        content.upsert_view(db, "default", row.id, blob=BLOB)
        assert row.view_rev == 1
        with pytest.raises(KeyError):
            content.upsert_view(db, "default", "nope", blob=BLOB)
