"""A batch applied and then taken back leaves no trace on the live model:
every ``rev``, every place in insertion order, every index and the state
digest as they were. One test per path that rolls a model batch back."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.routes.ops import _apply_batch, _rollback
from data_rover.api.schemas import ModelOpIn
from data_rover.api.serialize import iter_entity_lines
from data_rover.api.session import get_session
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from pydantic import TypeAdapter

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
    properties:
      - {name: name, datatype: string}
      - {name: note, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
  - name: Link
    source: Node
    target: Node
    properties:
      - {name: label, datatype: string}
"""

_OPS: TypeAdapter[list[ModelOpIn]] = TypeAdapter(list[ModelOpIn])


def _node(temp_id: str, name: str) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": {"name": name},
    }


def _rel(temp_id: str, kind: str, source: str, target: str) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": kind,
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _live() -> Model:
    model = get_session().model
    assert model is not None
    return model


def _seed(client: TestClient) -> dict[str, str]:
    """a contains b contains c, a links c; then revs moved apart."""
    res = client.post(
        papi("/model/ops"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                _node("tmp_a", "a"),
                _node("tmp_b", "b"),
                _node("tmp_c", "c"),
                _rel("tmp_ab", "Contains", "tmp_a", "tmp_b"),
                _rel("tmp_bc", "Contains", "tmp_b", "tmp_c"),
                _rel("tmp_ac", "Link", "tmp_a", "tmp_c"),
            ],
        },
    )
    assert res.status_code == 200, res.text
    ids: dict[str, str] = res.json()["id_map"]
    res = client.post(
        papi("/model/ops"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": ids["tmp_b"],
                    "properties_patch": {"note": "n"},
                },
                {
                    "kind": "update_relationship",
                    "id": ids["tmp_ac"],
                    "properties_patch": {"label": "x"},
                },
            ],
        },
    )
    assert res.status_code == 200, res.text
    return ids


def _observed(model: Model) -> tuple[list[str], str]:
    model.indexes.verify_consistent()
    return list(iter_entity_lines(model)), model_digest(model)


def _touching(ids: dict[str, str]) -> list[dict[str, Any]]:
    """Every kind of touch: an update of an element that stays and of one
    that goes, a cascade (so that what it takes must come back ahead of what
    was behind it), a create."""
    return [
        {
            "kind": "update_element",
            "id": ids["tmp_a"],
            "properties_patch": {"note": "kept"},
        },
        {
            "kind": "update_element",
            "id": ids["tmp_c"],
            "properties_patch": {"name": "c2", "note": "new"},
        },
        {"kind": "delete_element", "id": ids["tmp_b"]},
        _node("tmp_d", "d"),
        _rel("tmp_ad", "Link", ids["tmp_a"], "tmp_d"),
    ]


def test_a_refused_batch_leaves_no_trace(client: TestClient) -> None:
    ids = _seed(client)
    before = _observed(_live())
    rev = get_session().model_rev
    ghost = {"kind": "update_element", "id": "ghost", "properties_patch": {}}
    res = client.post(
        papi("/model/ops"), json={"base_rev": rev, "ops": [*_touching(ids), ghost]}
    )
    assert res.status_code == 422, res.text
    assert _observed(_live()) == before
    assert get_session().model_rev == rev


def test_a_preview_leaves_no_trace(client: TestClient) -> None:
    ids = _seed(client)
    before = _observed(_live())
    res = client.post(
        papi("/commits/preview"),
        json={"base_rev": get_session().model_rev, "ops": _touching(ids)},
    )
    assert res.status_code == 200, res.text
    assert _observed(_live()) == before


def test_a_staged_validation_leaves_no_trace(client: TestClient) -> None:
    ids = _seed(client)
    before = _observed(_live())
    res = client.post(
        papi("/model/validate"),
        json={"base_rev": get_session().model_rev, "ops": _touching(ids)},
    )
    assert res.status_code == 200, res.text
    assert _observed(_live()) == before


def test_a_commit_refused_for_a_structural_blocker_leaves_no_trace(
    client: TestClient,
) -> None:
    ids = _seed(client)
    before = _observed(_live())
    lock = client.post(
        papi("/locks"),
        json={
            # a connect edits its source and pins its target
            "targets": [
                {"resource_id": ids["tmp_c"], "mode": "exclusive"},
                {"resource_id": ids["tmp_a"], "mode": "shared"},
            ],
            "intent": "edit",
        },
    )
    assert lock.status_code == 200, lock.text
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": ids["tmp_c"],
                    "properties_patch": {"note": "new"},
                },
                # c already sits under b, which sits under a: a cycle
                _rel("tmp_ca", "Contains", ids["tmp_c"], ids["tmp_a"]),
            ],
            "lock_tokens": [lock.json()["token"]],
            "message": "cycle",
        },
    )
    assert res.status_code == 422, res.text
    assert res.json()["structural_blockers"]
    assert _observed(_live()) == before


def test_a_batch_that_could_not_be_persisted_leaves_no_trace(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = _seed(client)
    before = _observed(_live())
    rev = get_session().model_rev

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.routes.ops._persist_commit", _boom)
    res = client.post(papi("/model/ops"), json={"base_rev": rev, "ops": _touching(ids)})
    assert res.status_code == 500, res.text
    assert _observed(_live()) == before
    assert get_session().model_rev == rev


def test_rollback_puts_back_an_entity_whose_type_the_metamodel_lacks() -> None:
    metamodel = load_metamodel_str(_MM)
    raw = {
        "elements": [
            {"id": "e1", "type_name": "Gone", "properties": {"x": 1}, "rev": 4},
            {"id": "e2", "type_name": "Node", "properties": {"name": "n"}, "rev": 1},
        ],
        "relationships": [
            {
                "id": "r1",
                "type_name": "GoneToo",
                "source_id": "e1",
                "target_id": "e2",
                "properties": {},
                "rev": 2,
            }
        ],
    }
    model = build_model_from_dicts(metamodel, raw, strict=False)
    before = _observed(model)
    ops = _OPS.validate_python([{"kind": "delete_element", "id": "e1"}])
    res = _apply_batch(model, ops, restore=False)
    assert list(model.elements) == ["e2"]

    _rollback(model, res)
    assert _observed(model) == before
