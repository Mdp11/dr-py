from __future__ import annotations

from data_rover.api import content, db
from data_rover.api.db_models import Commit, Project


def _setup() -> None:
    db.init_engine("sqlite://", force=True)
    db.create_all()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))


def test_metamodel_and_model_upsert() -> None:
    _setup()
    with db.db_session() as s:
        mm = content.create_metamodel(s, name="MM", version=1, blob="x: 1")
        m = content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        assert m.model_rev == 0
        # upsert again rebinds without a second row
        m2 = content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        assert m2.id == m.id


def test_commit_append_and_read_tail() -> None:
    _setup()
    with db.db_session() as s:
        mm = content.create_metamodel(s, name="MM", version=1, blob="x: 1")
        content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        for rev in (1, 2, 3):
            content.append_commit(
                s, "p1", rev=rev, commit_id=f"c{rev}", author_id=None,
                ops=[{"kind": "noop"}], inverse_ops=[], id_map={},
            )
        content.set_model_rev(s, "p1", 3)
    with db.db_session() as s:
        tail = content.commits_after(s, "p1", 1)
        assert [c.rev for c in tail] == [2, 3]
        row = content.get_model_row(s, "p1")
        assert row is not None and row.model_rev == 3


def test_snapshot_record_and_latest() -> None:
    _setup()
    with db.db_session() as s:
        content.record_snapshot(s, "p1", rev=0, key="k0")
        content.record_snapshot(s, "p1", rev=5, key="k5")
    with db.db_session() as s:
        snap5 = content.latest_snapshot(s, "p1")
        assert snap5 is not None and snap5.rev == 5
        snap0 = content.latest_snapshot(s, "p1", max_rev=3)
        assert snap0 is not None and snap0.rev == 0
        assert content.latest_snapshot(s, "p1", max_rev=-1) is None


def test_clear_history_removes_commits_and_snapshots() -> None:
    _setup()
    with db.db_session() as s:
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={},
        )
        content.record_snapshot(s, "p1", rev=1, key="k1")
    with db.db_session() as s:
        content.clear_history(s, "p1")
    with db.db_session() as s:
        assert content.commits_after(s, "p1", 0) == []
        assert content.latest_snapshot(s, "p1") is None


def test_append_commit_persists_metadata() -> None:
    _setup()
    with db.db_session() as s:
        mm = content.create_metamodel(s, name="MM", version=1, blob="x: 1")
        content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={},
            message="rename node", validation_error_count=3,
            issues=[{"severity": "error", "message": "m", "category": "conformance"}],
        )
    with db.db_session() as s:
        c = content.commits_after(s, "p1", 0)[0]
        assert c.message == "rename node"
        assert c.validation_error_count == 3
        assert c.issues[0]["category"] == "conformance"


def _seed_project_with_commits(n: int) -> None:
    db.init_engine("sqlite://", force=True)
    db.create_all()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
        for rev in range(1, n + 1):
            s.add(
                Commit(
                    project_id="p1",
                    rev=rev,
                    commit_id=f"c{rev}",
                    author_id=None,
                    ops=[{"kind": "delete_element", "id": f"e{rev}"}],
                    inverse_ops=[],
                    id_map={},
                    message=f"commit {rev}",
                )
            )


def test_list_commits_is_rev_descending_and_limited() -> None:
    _seed_project_with_commits(5)
    with db.db_session() as s:
        rows = content.list_commits(s, "p1", before_rev=None, limit=3)
    assert [r.rev for r in rows] == [5, 4, 3]


def test_list_commits_before_rev_cursor() -> None:
    _seed_project_with_commits(5)
    with db.db_session() as s:
        rows = content.list_commits(s, "p1", before_rev=3, limit=10)
    assert [r.rev for r in rows] == [2, 1]
