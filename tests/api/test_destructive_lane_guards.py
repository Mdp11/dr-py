"""The two tools that drop a database's ``public`` schema refuse a database
that is not named for them."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

from tests.api.pg.conftest import refuse_unless_test_database

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "measure_thin_server.py"
_spec = importlib.util.spec_from_file_location("measure_thin_server", _SCRIPT)
assert _spec is not None and _spec.loader is not None
_script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_script)
refuse_unless_droppable = _script.refuse_unless_droppable

_DSN = "postgresql+psycopg://u:p@127.0.0.1:5432/{}"


@pytest.mark.parametrize("name", ["data_rover", "data_rover_prod", "test", "data_rover_test_x"])
def test_the_pg_lane_fails_on_a_database_not_named_for_tests(name: str) -> None:
    with pytest.raises(pytest.fail.Exception, match="must end in '_test'"):
        refuse_unless_test_database(make_url(_DSN.format(name)))


def test_the_pg_lane_takes_the_pixi_task_database() -> None:
    refuse_unless_test_database(make_url(_DSN.format("data_rover_test")))


@pytest.mark.parametrize("name", ["data_rover", "data_rover_prod", "measure_x"])
def test_the_measure_script_exits_on_a_database_not_named_for_it(name: str) -> None:
    with pytest.raises(SystemExit, match="refusing to drop"):
        refuse_unless_droppable(_DSN.format(name), allowed=False)


@pytest.mark.parametrize("name", ["data_rover_measure", "data_rover_test"])
def test_the_measure_script_takes_its_own_and_test_databases(name: str) -> None:
    refuse_unless_droppable(_DSN.format(name), allowed=False)


def test_the_measure_script_drops_any_database_when_told_to() -> None:
    refuse_unless_droppable(_DSN.format("data_rover"), allowed=True)
