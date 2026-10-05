from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Integer, String, create_engine, inspect, text
from sqlalchemy.orm import Session

from data_rover.api.db_models import ArtifactKind, ArtifactRow, Project

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_migration_creates_all_tables(tmp_path: Path) -> None:
    db_path = tmp_path / "t.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")

    engine = create_engine(url)
    tables = {"users", "projects", "memberships"}
    assert set(inspect(engine).get_table_names()) >= tables

    # downgrade round-trips cleanly (guards future downgrade-ordering regressions)
    command.downgrade(cfg, "base")
    assert not tables & set(inspect(engine).get_table_names())


def test_migration_creates_content_tables(tmp_path: Path) -> None:
    db_path = tmp_path / "t2.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")

    engine = create_engine(url)
    content = {"metamodels", "models", "views", "commits", "snapshots", "project_artifacts"}
    assert content <= set(inspect(engine).get_table_names())

    command.downgrade(cfg, "base")
    assert not content & set(inspect(engine).get_table_names())


def test_migration_adds_validation_policy_column(tmp_path: Path) -> None:
    db_path = tmp_path / "t.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")
    engine = create_engine(url)
    cols = {c["name"] for c in inspect(engine).get_columns("models")}
    assert "validation_policy" in cols

    command.downgrade(cfg, "0004")
    cols = {c["name"] for c in inspect(engine).get_columns("models")}
    assert "validation_policy" not in cols


def test_migration_0011_widens_kind_and_preserves_fks_and_unique(
    tmp_path: Path,
) -> None:
    # 0011 (`custom_export`, since renamed to `exporter` by 0012) rebuilds
    # project_artifacts via batch mode on SQLite (a plain
    # `ALTER COLUMN ... TYPE` isn't valid SQLite DDL). A batch recreate is a
    # real risk to everything else riding on that table -- this pins that the
    # two FKs (with their ondelete behavior) and the named unique constraint
    # all survive the rebuild, and that a kind value round-trips through the
    # widened column (the actual reason the migration exists: the
    # then-13-char `custom_export` literal).
    db_path = tmp_path / "t4.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")

    engine = create_engine(url)
    insp = inspect(engine)

    # SQLite reflection doesn't name unnamed FKs, so key by constrained column.
    fks = {
        fk["constrained_columns"][0]: fk
        for fk in insp.get_foreign_keys("project_artifacts")
    }
    assert fks["project_id"]["referred_table"] == "projects"
    assert fks["project_id"].get("options", {}).get("ondelete") == "CASCADE"
    assert fks["updated_by"]["referred_table"] == "users"
    assert fks["updated_by"].get("options", {}).get("ondelete") == "SET NULL"

    uniques = {u["name"]: u for u in insp.get_unique_constraints("project_artifacts")}
    assert uniques["uq_artifact_project_kind_name"]["column_names"] == [
        "project_id",
        "kind",
        "name",
    ]

    # the entire reason 0011 exists: "custom_export" (13 chars) had to fit
    # (the kind is now named `exporter`, 0012 renamed the stored literal).
    with Session(engine) as s:
        s.add(Project(id="p1", name="P1"))
        s.add(
            ArtifactRow(
                id="a1",
                project_id="p1",
                kind=ArtifactKind.exporter,
                name="n",
                payload={},
                artifact_rev=1,
            )
        )
        s.commit()
        row = s.get(ArtifactRow, "a1")
        assert row is not None
        assert row.kind == ArtifactKind.exporter


def test_migration_0013_adds_commit_entity_states(tmp_path: Path) -> None:
    db_path = tmp_path / "t5.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")
    engine = create_engine(url)
    cols = {c["name"]: c for c in inspect(engine).get_columns("commits")}
    assert "entity_states" in cols
    assert cols["entity_states"]["nullable"] is True

    command.downgrade(cfg, "0012")
    cols = {c["name"] for c in inspect(engine).get_columns("commits")}
    assert "entity_states" not in cols


def test_migration_0015_adds_commit_state_digest(tmp_path: Path) -> None:
    db_path = tmp_path / "t6.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")
    engine = create_engine(url)
    cols = {c["name"]: c for c in inspect(engine).get_columns("commits")}
    assert "state_digest" in cols
    assert cols["state_digest"]["nullable"] is True

    command.downgrade(cfg, "0014")
    cols = {c["name"] for c in inspect(engine).get_columns("commits")}
    assert "state_digest" not in cols


def test_migration_0016_adds_snapshot_format_columns(tmp_path: Path) -> None:
    db_path = tmp_path / "t7.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "0015")
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO projects (id, name) VALUES ('p1', 'P1')"))
        conn.execute(
            text(
                "INSERT INTO snapshots (project_id, rev, key, ts) "
                "VALUES ('p1', 3, 'k3', '2026-09-19 00:00:00')"
            )
        )

    command.upgrade(cfg, "head")
    new = ("format", "metamodel_id", "state_digest", "elements", "relationships")
    cols = {c["name"]: c for c in inspect(engine).get_columns("snapshots")}
    for name in new:
        assert cols[name]["nullable"] is True
    assert isinstance(cols["format"]["type"], String)
    assert cols["format"]["type"].length == 8
    assert isinstance(cols["metamodel_id"]["type"], String)
    assert isinstance(cols["state_digest"]["type"], String)
    assert cols["state_digest"]["type"].length == 16
    assert isinstance(cols["elements"]["type"], Integer)
    assert isinstance(cols["relationships"]["type"], Integer)
    fk_cols = {
        c
        for fk in inspect(engine).get_foreign_keys("snapshots")
        for c in fk["constrained_columns"]
    }
    assert "metamodel_id" not in fk_cols
    with engine.connect() as conn:
        row = conn.execute(
            text(f"SELECT key, {', '.join(new)} FROM snapshots WHERE rev = 3")
        ).one()
    assert tuple(row) == ("k3", None, None, None, None, None)

    command.downgrade(cfg, "0015")
    cols = {c["name"]: c for c in inspect(engine).get_columns("snapshots")}
    assert not set(new) & set(cols)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT key FROM snapshots")).scalars().all() == ["k3"]


def test_migration_0017_makes_commit_count_nullable(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 't8.db'}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "0016")
    engine = create_engine(url)
    cols = {c["name"]: c for c in inspect(engine).get_columns("commits")}
    assert cols["validation_error_count"]["nullable"] is False

    command.upgrade(cfg, "head")
    cols = {c["name"]: c for c in inspect(engine).get_columns("commits")}
    assert cols["validation_error_count"]["nullable"] is True


def test_migration_0017_downgrade_backfills_null_counts(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 't9.db'}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO projects (id, name) VALUES ('p1', 'P1')"))
        conn.execute(
            text(
                "INSERT INTO commits (project_id, rev, commit_id, ts, ops, inverse_ops, "
                "id_map, message, validation_error_count, issues) "
                "VALUES ('p1', 1, 'c1', '2026-09-19 00:00:00', '[]', '[]', '{}', '', "
                "NULL, '[]')"
            )
        )

    command.downgrade(cfg, "0016")
    cols = {c["name"]: c for c in inspect(engine).get_columns("commits")}
    assert cols["validation_error_count"]["nullable"] is False
    with engine.connect() as conn:
        count = conn.execute(
            text("SELECT validation_error_count FROM commits WHERE rev = 1")
        ).scalar_one()
    assert count == 0


def test_migration_0018_adds_head_tables_and_model_columns(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 't10.db'}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "0017")
    engine = create_engine(url)
    head_tables = {"elements", "relationships", "entity_refs"}
    assert not head_tables & set(inspect(engine).get_table_names())
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO projects (id, name) VALUES ('p1', 'P1')"))
        conn.execute(
            text("INSERT INTO metamodels (id, name, version, blob, created_at) "
                 "VALUES ('m1', '', 1, '', '2026-10-05 00:00:00')")
        )
        conn.execute(
            text("INSERT INTO models (id, project_id, metamodel_id, name, model_rev) "
                 "VALUES ('x1', 'p1', 'm1', 'model', 3)")
        )

    command.upgrade(cfg, "0018")
    insp = inspect(engine)
    assert head_tables <= set(insp.get_table_names())
    cols = {c["name"]: c for c in insp.get_columns("models")}
    assert cols["state_digest"]["nullable"] is True
    assert cols["next_seq"]["nullable"] is True
    assert cols["element_count"]["nullable"] is False
    assert cols["relationship_count"]["nullable"] is False
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT model_rev, element_count, relationship_count, next_seq, "
                 "state_digest FROM models")
        ).one()
    assert tuple(row) == (3, 0, 0, None, None)

    rel_cols = {c["name"] for c in insp.get_columns("relationships")}
    assert {"project_id", "id", "type_name", "properties", "rev", "seq",
            "source_id", "target_id"} == rel_cols
    assert {i["name"] for i in insp.get_indexes("relationships")} >= {
        "ix_rel_source", "ix_rel_target"
    }
    assert {i["name"] for i in insp.get_indexes("entity_refs")} >= {"ix_refs_target"}
    assert insp.get_pk_constraint("entity_refs")["constrained_columns"] == [
        "project_id", "referencer_id", "target_id"
    ]
    for table in ("elements", "relationships"):
        assert any(
            u["column_names"] == ["project_id", "seq"]
            for u in insp.get_unique_constraints(table)
        )
        fks = insp.get_foreign_keys(table)
        assert fks[0]["referred_table"] == "projects"
        assert fks[0].get("options", {}).get("ondelete") == "CASCADE"

    command.downgrade(cfg, "0017")
    insp = inspect(engine)
    assert not head_tables & set(insp.get_table_names())
    cols = {c["name"] for c in insp.get_columns("models")}
    assert not {"state_digest", "element_count", "relationship_count", "next_seq"} & cols
    with engine.connect() as conn:
        assert conn.execute(text("SELECT model_rev FROM models")).scalar_one() == 3
