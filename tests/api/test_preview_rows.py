"""POST /commits/preview answers from the rows.

The model half runs through the commit's own check (``load_and_apply``) in a
transaction that is rolled back, so the rows, the refs, the revision and the
session's metamodel are as they were. The session's model is never read.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from data_rover.api import db
from data_rover.api.db_models import EntityRefRow
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

from .conftest import (
    AUTH_HEADERS,
    head,
    install,
    papi,
    seed_default_project,
    without_session_model,
)

_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
      - {name: ref, datatype: string, multiplicity: "0..1"}
  - name: Gadget
relationships:
  - name: Link
    source: Node
    target: Node
"""


def _node(eid: str, **props: Any) -> dict[str, Any]:
    return {"id": eid, "type_name": "Node", "properties": props}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(
        metamodel=_MM,
        model=json.dumps(
            {
                "elements": [_node("a", label="one"), _node("b", ref="a")],
                "relationships": [
                    {
                        "id": "l",
                        "type_name": "Link",
                        "source_id": "a",
                        "target_id": "b",
                        "properties": {},
                    }
                ],
            }
        ),
    )
    return c


def _preview(client: TestClient, ops: list[dict], base_rev: int | None = None) -> Any:
    return client.post(
        papi("/commits/preview"),
        json={"base_rev": head().rev if base_rev is None else base_rev, "ops": ops},
    )


def _refs() -> set[tuple[str, str]]:
    with db.db_session() as s:
        return {
            (r.referencer_id, r.target_id)
            for r in s.scalars(
                select(EntityRefRow).where(
                    EntityRefRow.project_id == DEFAULT_PROJECT_ID
                )
            )
        }


def _create(temp: str, type_name: str = "Node", **props: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp,
        "type_name": type_name,
        "properties": props,
    }


def test_preview_answers_with_no_session_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = head()
    without_session_model(monkeypatch)
    r = _preview(
        client,
        [
            _create("tmp_n", label="new"),
            {"kind": "update_element", "id": "a", "properties_patch": {"label": "two"}},
            {"kind": "delete_element", "id": "b"},
        ],
    )
    assert r.status_code == 200, r.text
    assert head() == before


def test_preview_refuses_what_the_applier_refuses(client: TestClient) -> None:
    unknown_type = _preview(client, [_create("tmp_x", "Nope")])
    assert unknown_type.status_code == 422
    unknown_property = _preview(client, [_create("tmp_x", nope=1)])
    assert unknown_property.status_code == 422
    missing_endpoint = _preview(
        client,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Link",
                "source_id": "a",
                "target_id": "ghost",
            }
        ],
    )
    assert missing_endpoint.status_code == 422
    assert head().rev == 0 and len(head().elements) == 2


def test_preview_base_rev_is_checked_against_the_model_row(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    without_session_model(monkeypatch)
    r = _preview(client, [], base_rev=9)
    assert r.status_code == 409
    assert r.json() == {"detail": "stale base_rev", "model_rev": 0}


def test_preview_does_not_touch_the_session_revision(client: TestClient) -> None:
    session = get_registry().get(DEFAULT_PROJECT_ID)
    session.model_rev = 41  # the model row says 0, and it decides
    assert _preview(client, [_create("tmp_n")]).status_code == 200


def test_preview_of_a_rebind_checks_the_rows_against_the_candidate(
    client: TestClient,
) -> None:
    blob = _MM.replace("  - name: Gadget\n", "")
    ok = _preview(client, [{"kind": "metamodel.rebind", "blob": blob}])
    assert ok.status_code == 200, ok.text

    drops_label = _MM.replace("      - {name: label, datatype: string}\n", "")
    r = _preview(client, [{"kind": "metamodel.rebind", "blob": drops_label}])
    assert r.status_code == 422, r.text
    assert "cannot hold: a" in r.json()["detail"]


def test_preview_of_a_rebind_runs_the_batch_under_the_candidate_and_changes_nothing(
    client: TestClient,
) -> None:
    before_refs = _refs()
    session = get_registry().get(DEFAULT_PROJECT_ID)
    prior = session.metamodel
    candidate = _MM.replace("name: ref, datatype: string", "name: ref, datatype: Node")
    gadget_extra = candidate.replace(
        "  - name: Gadget\n",
        "  - name: Gadget\n    properties:\n      - {name: extra, datatype: string}\n",
    )
    r = _preview(
        client,
        [
            {"kind": "metamodel.rebind", "blob": gadget_extra},
            _create("tmp_g", "Gadget", extra="x"),
        ],
    )
    assert r.status_code == 200, r.text
    assert head().rev == 0
    assert _refs() == before_refs == set()
    assert get_registry().get(DEFAULT_PROJECT_ID).metamodel is prior
    assert session.model is not None and session.model.metamodel is prior
    # the batch's own property needs the candidate: without it, a 422
    assert _preview(client, [_create("tmp_g", "Gadget", extra="x")]).status_code == 422


def test_preview_of_a_rebind_refuses_a_dangling_reference(client: TestClient) -> None:
    install(
        metamodel=_MM,
        model=json.dumps({"elements": [_node("a", ref="ghost")], "relationships": []}),
    )
    candidate = _MM.replace("name: ref, datatype: string", "name: ref, datatype: Node")
    r = _preview(client, [{"kind": "metamodel.rebind", "blob": candidate}])
    assert r.status_code == 422, r.text
    assert "held by: a" in r.json()["detail"]
    assert _refs() == set()


def test_preview_of_a_rebind_is_owner_only(client: TestClient) -> None:
    from data_rover.api.db_models import Role, User
    from data_rover.api.tenancy import add_member

    with db.db_session() as s:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.editor)
    r = client.post(
        papi("/commits/preview"),
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
        json={"base_rev": 0, "ops": [{"kind": "metamodel.rebind", "blob": _MM}]},
    )
    assert r.status_code == 403


def test_preview_of_a_project_without_a_model_row_is_404() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/commits/preview"), json={"base_rev": 0, "ops": []})
    assert r.status_code == 404
