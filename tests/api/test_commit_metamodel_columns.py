from data_rover.api import content, db
from data_rover.api.db_models import Commit, MetamodelRow, Project


def test_append_commit_records_rebind_metamodel_ids() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(Project(id="p1", name="P1"))
        old = content.create_metamodel(s, name="", version=1, blob="elements: []")
        new = content.create_metamodel(s, name="", version=2, blob="elements: []")
        content.upsert_model_row(s, "p1", metamodel_id=new.id)
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={},
            from_metamodel_id=old.id, to_metamodel_id=new.id,
        )
        s.commit()
        row = s.get(Commit, ("p1", 1))
        assert row.from_metamodel_id == old.id
        assert row.to_metamodel_id == new.id
    finally:
        gen.close()
        db.drop_all()
