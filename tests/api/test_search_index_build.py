"""Chunked background build of the trigram search index (the search-side
sibling of validation_sweep). Sync mode is what the API suite runs under
(conftest pins it); these tests exercise both modes, chunk interleaving with
live edits, and the abort-on-model-replace guard."""

from __future__ import annotations

import time

import pytest

from data_rover.api import search_index_build
from data_rover.api.search_index_build import start_search_index_build
from data_rover.api.session import Session
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
"""


def _bulk_session(n: int) -> Session:
    metamodel = load_metamodel_str(MM)
    model = Model(metamodel)
    for i in range(n):
        model.elements[f"e{i}"] = Element(
            id=f"e{i}", type_name="Item", properties={"name": f"pump {i}"}
        )
    model.indexes.rebuild()  # bulk-load path: search index reset, not ready
    return Session(metamodel=metamodel, model=model)


def test_sync_build_completes_and_answers() -> None:
    session = _bulk_session(10)
    assert session.model is not None
    assert session.model.indexes.search_candidates("pump") is None
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert (progress.done, progress.total) == (10, 10)
    assert session.model.indexes.search_ready is True
    assert session.model.indexes.search_candidates("pump") == {f"e{i}" for i in range(10)}
    session.model.indexes.verify_consistent()


def test_async_build_completes() -> None:
    session = _bulk_session(50)
    progress = start_search_index_build(session, sync=False)
    deadline = time.monotonic() + 10.0
    while progress.running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert progress.running is False
    assert session.model is not None
    assert session.model.indexes.search_ready is True
    session.model.indexes.verify_consistent()


def test_multi_chunk_build_skips_edited_and_deleted(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force several chunks and mutate between them through the hooks: the
    builder must skip what the hooks already indexed and what no longer
    exists, converging on a verify_consistent-clean index."""
    monkeypatch.setattr(search_index_build, "CHUNK_SIZE", 3)
    session = _bulk_session(8)
    model = session.model
    assert model is not None
    calls = 0
    orig = model.indexes.index_search_chunk

    def spy(ids):
        nonlocal calls
        calls += 1
        if calls == 1:
            # mutations landing AFTER the id snapshot, BEFORE later chunks
            model.set_property(model.elements["e7"], "name", "valve 7")
            model.delete_element("e6")
            model.set_property(model.create_element("Item"), "name", "boiler")
        orig(ids)

    monkeypatch.setattr(model.indexes, "index_search_chunk", spy)
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert calls == 3  # 3 + 3 + 2
    assert model.indexes.search_candidates("valve") == {"e7"}
    assert model.indexes.search_candidates("boiler") is not None
    assert "e6" not in (model.indexes.search_candidates("pump") or set())
    model.indexes.verify_consistent()


def test_build_aborts_when_model_is_replaced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search_index_build, "CHUNK_SIZE", 2)
    session = _bulk_session(6)
    old = session.model
    assert old is not None
    calls = 0
    orig = old.indexes.index_search_chunk

    def spy(ids):
        nonlocal calls
        calls += 1
        orig(ids)
        if calls == 1:
            assert session.metamodel is not None
            session.set_model(Model(session.metamodel))

    monkeypatch.setattr(old.indexes, "index_search_chunk", spy)
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert calls == 1  # aborted at the next chunk's identity check
    assert old.indexes.search_ready is False  # never marked ready
    assert progress.done < progress.total


def test_build_aborts_when_index_is_reset_mid_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``rebuild()`` on the live model between chunks clears the postings
    the build is filling and drops ``search_ready`` without changing
    ``session.model``/``model.indexes`` identity; the generation counter
    must catch it where the identity check alone would not."""
    monkeypatch.setattr(search_index_build, "CHUNK_SIZE", 2)
    session = _bulk_session(6)
    model = session.model
    assert model is not None
    calls = 0
    orig = model.indexes.index_search_chunk

    def spy(ids):
        nonlocal calls
        calls += 1
        orig(ids)
        if calls == 1:
            model.indexes.rebuild()

    monkeypatch.setattr(model.indexes, "index_search_chunk", spy)
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert calls == 1  # aborted at the next chunk's generation check
    assert model.indexes.search_ready is False  # never marked ready
    assert progress.done < progress.total


def test_already_ready_index_is_a_noop() -> None:
    metamodel = load_metamodel_str(MM)
    session = Session(metamodel=metamodel, model=Model(metamodel))
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert session.model is not None and session.model.indexes.search_ready is True


def test_session_field_holds_the_build_progress() -> None:
    session = _bulk_session(3)
    progress = start_search_index_build(session, sync=True)
    assert session.search_index_build is progress


def test_build_stops_early_when_cancelled_mid_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(search_index_build, "CHUNK_SIZE", 2)
    session = _bulk_session(6)
    model = session.model
    assert model is not None
    calls = 0
    orig = model.indexes.index_search_chunk

    def spy(ids):
        nonlocal calls
        calls += 1
        if calls == 1:
            # the evict path sets .cancel on session.search_index_build
            in_flight = session.search_index_build
            assert in_flight is not None
            in_flight.cancel.set()
        orig(ids)

    monkeypatch.setattr(model.indexes, "index_search_chunk", spy)
    progress = start_search_index_build(session, sync=True)
    assert progress.running is False
    assert calls == 1  # stopped at the next chunk's cancel check
    assert model.indexes.search_ready is False  # never marked ready
    assert progress.done < progress.total
