from __future__ import annotations

from data_rover.api import db
from data_rover.api.db_models import (
    Commit,
    MetamodelRow,
    ModelRow,
    Project,
    Snapshot,
)


def _engine():
    db.init_engine("sqlite://", force=True)
    db.create_all()


def test_model_row_one_to_one_with_project() -> None:
    _engine()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
        s.add(MetamodelRow(id="mm1", name="MM", version=1, blob="x: 1"))
        s.add(ModelRow(id="m1", project_id="p1", metamodel_id="mm1", name="model"))
    with db.db_session() as s:
        row = s.get(ModelRow, "m1")
        assert row is not None and row.model_rev == 0


def test_commit_pk_is_project_and_rev() -> None:
    _engine()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
        s.add(
            Commit(
                project_id="p1",
                rev=0,
                commit_id="c0",
                author_id=None,
                ops=[],
                inverse_ops=[],
                id_map={},
            )
        )
    with db.db_session() as s:
        c = s.get(Commit, ("p1", 0))
        assert c is not None and c.commit_id == "c0"


def test_snapshot_and_cascade_delete_with_project() -> None:
    _engine()
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
        s.add(Snapshot(project_id="p1", rev=0, key="projects/p1/snapshots/0.json"))
    with db.db_session() as s:
        s.delete(s.get(Project, "p1"))
    with db.db_session() as s:
        assert s.get(Snapshot, ("p1", 0)) is None  # FK ON DELETE CASCADE
