from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

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
    content = {"metamodels", "models", "views", "commits", "snapshots"}
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
