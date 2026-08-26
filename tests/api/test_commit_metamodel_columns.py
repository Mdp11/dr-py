from data_rover.api import content, db
from data_rover.api.db_models import Commit, Project


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
        assert row is not None
        assert row.from_metamodel_id == old.id
        assert row.to_metamodel_id == new.id
    finally:
        gen.close()
        db.drop_all()


def test_append_commit_records_entity_states_and_defaults_to_null() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(Project(id="p1", name="P1"))
        states = {
            "elements": {
                "e1": {
                    "before": None,
                    "after": {"id": "e1", "type_name": "Node", "properties": {}, "rev": 0},
                }
            },
            "relationships": {},
        }
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={}, entity_states=states,
        )
        content.append_commit(
            s, "p1", rev=2, commit_id="c2", author_id=None,
            ops=[], inverse_ops=[], id_map={},
        )
        s.commit()
        row1 = s.get(Commit, ("p1", 1))
        row2 = s.get(Commit, ("p1", 2))
        assert row1 is not None and row1.entity_states == states
        assert row2 is not None and row2.entity_states is None
    finally:
        gen.close()
        db.drop_all()
