from __future__ import annotations

import pytest

from data_rover.api import content, db
from data_rover.api.db_models import ArtifactKind, Commit, Project


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


def test_commits_between_is_bounded_and_ascending() -> None:
    from data_rover.api import content
    from data_rover.api.db import get_db
    from data_rover.api.db_models import Commit, Project
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = get_db()
    s = next(gen)
    try:
        s.add(Project(id=DEFAULT_PROJECT_ID, name="p"))
        for r in (1, 2, 3, 4):
            s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=r, commit_id=f"c{r}",
                         author_id=None, ops=[], inverse_ops=[], id_map={}, message=""))
        s.commit()
        out = content.commits_between(s, DEFAULT_PROJECT_ID, after_rev=1, max_rev=3)
        assert [c.rev for c in out] == [2, 3]
    finally:
        gen.close()


def test_first_rebind_after_finds_earliest_rebind() -> None:
    from data_rover.api import content
    from data_rover.api.db import get_db
    from data_rover.api.db_models import Commit, MetamodelRow, Project
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = get_db()
    s = next(gen)
    try:
        s.add(Project(id=DEFAULT_PROJECT_ID, name="p"))
        s.add(MetamodelRow(id="m1", name="M1", version=1, blob="x: 1"))
        s.add(MetamodelRow(id="m2", name="M2", version=1, blob="x: 2"))
        s.add(MetamodelRow(id="m3", name="M3", version=1, blob="x: 3"))
        s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=1, commit_id="c1", author_id=None,
                     ops=[], inverse_ops=[], id_map={}, message=""))
        s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=2, commit_id="c2", author_id=None,
                     ops=[], inverse_ops=[], id_map={}, message="",
                     from_metamodel_id="m1", to_metamodel_id="m2"))
        s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=3, commit_id="c3", author_id=None,
                     ops=[], inverse_ops=[], id_map={}, message="",
                     from_metamodel_id="m2", to_metamodel_id="m3"))
        s.commit()
        r0 = content.first_rebind_after(s, DEFAULT_PROJECT_ID, 0)
        assert r0 is not None and r0.rev == 2
        r2 = content.first_rebind_after(s, DEFAULT_PROJECT_ID, 2)
        assert r2 is not None and r2.rev == 3
        assert content.first_rebind_after(s, DEFAULT_PROJECT_ID, 3) is None
    finally:
        gen.close()


def test_artifact_crud_roundtrip() -> None:
    _setup()
    with db.db_session() as s:
        row = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="Sensors",
            payload={"kind": "path"}, updated_by=None,
        )
        aid = row.id
        assert row.artifact_rev == 1
    with db.db_session() as s:
        row = content.get_artifact(s, aid)
        assert row is not None and row.name == "Sensors"
        assert content.find_artifact(s, "p1", ArtifactKind.navigation, "Sensors") is not None
        assert [r.id for r in content.list_artifacts(s, "p1")] == [aid]
        assert content.list_artifacts(s, "p1", ArtifactKind.table) == []


def test_artifact_update_bumps_rev_and_rejects_stale() -> None:
    _setup()
    with db.db_session() as s:
        row = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="N",
            payload={}, updated_by=None,
        )
        aid = row.id
    with db.db_session() as s:
        row = content.get_artifact(s, aid)
        assert row is not None
        # updated_by=None: this test seeds no User row and updated_by is an FK
        # (SQLite runs with PRAGMA foreign_keys=ON); route tests cover the id.
        content.update_artifact(s, row, expected_rev=1, name="N2", updated_by=None)
        assert row.artifact_rev == 2
    with db.db_session() as s:
        row = content.get_artifact(s, aid)
        assert row is not None
        with pytest.raises(content.StaleArtifactError) as exc:
            content.update_artifact(s, row, expected_rev=1, payload={"x": 1},
                                    updated_by=None)
        assert exc.value.current_rev == 2


def test_artifact_delete() -> None:
    _setup()
    with db.db_session() as s:
        row = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="N",
            payload={}, updated_by=None,
        )
        aid = row.id
        content.delete_artifact(s, row)
        assert content.get_artifact(s, aid) is None


def test_artifact_project_cascade_delete() -> None:
    _setup()
    with db.db_session() as s:
        row = content.create_artifact(
            s, "p1", kind=ArtifactKind.navigation, name="N",
            payload={}, updated_by=None,
        )
        aid = row.id
    with db.db_session() as s:
        s.delete(s.get(Project, "p1"))
    with db.db_session() as s:
        assert content.get_artifact(s, aid) is None  # FK ON DELETE CASCADE
