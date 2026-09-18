"""The committed golden fixtures must be what the Python core produces today."""

from __future__ import annotations

from tests.golden.driver import stale


def test_committed_golden_fixtures_are_current() -> None:
    assert stale() == [], "run `pixi run golden-fixtures` and commit the result"
