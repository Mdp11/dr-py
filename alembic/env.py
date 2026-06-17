from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from data_rover.api import db_models  # noqa: F401  (registers tables)
from data_rover.api.db import Base
from data_rover.api.settings import get_settings

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# URL comes from settings (env DATA_ROVER_DATABASE_URL) unless set in the ini.
# Note: with no ini URL, no env var, and no .env, this falls back to the
# Settings Postgres default — so `alembic upgrade` in a bare shell targets the
# local default DB. Set DATA_ROVER_DATABASE_URL explicitly in deploys.
if not config.get_main_option("sqlalchemy.url"):
    config.set_main_option("sqlalchemy.url", get_settings().database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url") or ""
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # SQLite can't ALTER most things in place; batch mode emits
        # copy-and-replace DDL so future migrations also apply on SQLite (tests).
        render_as_batch=url.startswith("sqlite"),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # batch mode for SQLite (tests) so ALTER-based migrations apply;
            # a no-op on Postgres (production).
            render_as_batch=connection.dialect.name == "sqlite",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
