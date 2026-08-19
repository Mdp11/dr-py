from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect
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
