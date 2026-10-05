"""The server's op applier reproduces the frozen op fixtures: what each batch
reports (id map, changed, deleted and recreated ids, ``before_*``, inverse
ops), the digest and the indexes it leaves."""

from __future__ import annotations

import pytest

from tests.golden.reader import load_fixture, replay


@pytest.mark.parametrize(
    "name", ["ops_batches", "ops_churn", "ops_recreate", "ops_refused"]
)
def test_applier_matches_the_fixture(name: str) -> None:
    pairs = replay(load_fixture(name))
    assert pairs
    for index, (recorded, replayed) in enumerate(pairs):
        assert replayed == recorded, f"{name} step {index}"
