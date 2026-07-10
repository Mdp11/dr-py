"""Chunked background validation sweep (spec §3).

Sync mode is what the rest of the API suite runs under (conftest pins it);
these tests exercise both modes plus the abort-on-model-replace guard.
"""

from __future__ import annotations

import time

import pytest

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.state import ValidationState
from data_rover.api.session import Session
from data_rover.api import validation_sweep
from data_rover.api.validation_sweep import start_validation_sweep

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""


def _session(n: int) -> Session:
    metamodel = load_metamodel_str(MM)
    model = Model(metamodel)
    for _ in range(n):
        model.create_element("Item")  # missing required name -> 1 issue each
    session = Session(metamodel=metamodel, model=model)
    session.validation = ValidationState()
    return session


def _expected_issue_count(n: int) -> int:
    """n multiplicity issues (missing required ``name``) PLUS n-1 uniqueness
    issues: ``Item`` declares no ``key``, so n elements with identical
    (empty) properties form one duplicate group with n-1 non-primary
    members. This holds for a plain full ``Scope.all()`` run too — it is
    inherent to the fixture's unkeyed identical elements, not an artifact of
    chunking."""
    return n + (n - 1) if n else 0


def test_sync_sweep_seeds_all_issues() -> None:
    session = _session(10)
    progress = start_validation_sweep(session, sync=True)
    assert progress.running is False
    assert (progress.done, progress.total) == (10, 10)
    assert session.validation is not None
    assert len(session.validation.all_issues()) == _expected_issue_count(10)


def test_async_sweep_completes() -> None:
    session = _session(50)
    progress = start_validation_sweep(session, sync=False)
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
    assert session.validation is not None
    assert len(session.validation.all_issues()) == _expected_issue_count(50)


def test_multi_chunk_sweep_covers_all_entities(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Force several chunks (production CHUNK_SIZE dwarfs test fixtures, so
    the multi-chunk path — including uniqueness groups spanning chunk
    boundaries — is otherwise never exercised)."""
    monkeypatch.setattr(validation_sweep, "CHUNK_SIZE", 7)
    session = _session(20)  # 7 + 7 + 6: two full chunks plus a partial tail
    progress = start_validation_sweep(session, sync=True)
    assert progress.running is False
    assert (progress.done, progress.total) == (20, 20)
    assert session.validation is not None
    assert len(session.validation.all_issues()) == _expected_issue_count(20)


def test_sweep_aborts_when_model_replaced() -> None:
    session = _session(50)
    swept_model = session.model
    progress = start_validation_sweep(session, sync=False)
    session.set_model(None)  # clears validation; sweep must notice and stop
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
    assert session.model is not swept_model
    assert session.validation is None  # the aborted sweep spliced nothing back


def test_cancel_event_stops_sweep() -> None:
    session = _session(50)
    progress = start_validation_sweep(session, sync=False)
    progress.cancel.set()
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
