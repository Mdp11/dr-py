"""Metamodel ops through the commit flow (spec 2026-08-16). This file grows
across Tasks 2-7; each task appends its section."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content
from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, papi, seed_default_project

MM_V1 = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
"""

MM_V2 = """
elements:
  - name: Node
"""

#: V1 + a SECOND property. The migration test patches ``owner_name`` in the
#: same batch that rebinds to this: the op is only legal once the swap is
#: live (``_check_patch_keys`` rejects an unknown key), which is exactly what
#: "the rebind is hoisted first, everything else validates against the NEW
#: schema" has to mean. See ``test_migration_batch_lands_atomically``.
MM_V4 = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
      - name: owner_name
        datatype: string
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"),
        content=MM_V1,
        headers={"Content-Type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    # The brief's fixture stops after the metamodel upload, but
    # ``set_metamodel`` clears ``session.model`` to None (session.py), and
    # every sibling commit-flow test fixture (test_commits_artifact_ops.py,
    # test_commits_view_ops.py, ...) follows the metamodel upload with an
    # empty-model POST for exactly that reason — without it, ``require_model``
    # 404s "No model loaded" before any op-family check ever runs. Added here
    # to match that established pattern (same category as the
    # MetamodelNodePos dict-literal ruling: verbatim brief text needing a
    # small, obviously-required fix to actually run).
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(client: TestClient) -> int:
    return get_session().model_rev


def test_split_ops_separates_metamodel_family() -> None:
    from data_rover.api.artifact_ops import split_ops
    from data_rover.api.schemas import (
        DeleteElementOp,
        MoveMetamodelNodeOp,
        RebindMetamodelOp,
    )

    model, art, view, mm = split_ops(
        [
            RebindMetamodelOp(kind="metamodel.rebind", blob="x: 1\n"),
            DeleteElementOp(kind="delete_element", id="e1"),
            MoveMetamodelNodeOp(kind="metamodel.move_node", node="el:A", pos=None),
        ]
    )
    assert [type(o).__name__ for o in mm] == [
        "RebindMetamodelOp",
        "MoveMetamodelNodeOp",
    ]
    assert len(model) == 1 and not art and not view


def test_model_ops_route_rejects_metamodel_ops(client: TestClient) -> None:
    r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.move_node", "node": "el:Node", "pos": None}],
        },
    )
    assert r.status_code == 422
    assert "commits" in r.json()["detail"]


def test_validate_route_rejects_metamodel_ops(client: TestClient) -> None:
    # Not in the brief's file list (found by grepping split_ops( call sites):
    # routes/validation.py destructures split_ops too, and mirrors the
    # existing PERMANENT artifact/view rejection there (test_view_op_schemas.py
    # ::test_validate_route_rejects_view_ops is the sibling for that pattern).
    r = client.post(
        papi("/model/validate"),
        json={"ops": [{"kind": "metamodel.move_node", "node": "el:Node", "pos": None}]},
    )
    assert r.status_code == 422
    assert "commits" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Task 5: metamodel ops through POST /commits
# ---------------------------------------------------------------------------

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str, role_name: str = "editor") -> None:
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role(role_name))
    finally:
        gen.close()


def _acquire_mm(client: TestClient) -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _acquire_element(client: TestClient, eid: str) -> str:
    """An update/delete op in a batch requires the element's EXCLUSIVE lease
    at verify time — migration batches must hold BOTH tokens (mm + element)."""
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": eid, "mode": "exclusive"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _create_node(client: TestClient, label: str | None = None) -> str:
    """Seed one Node. ``label=None`` leaves the property UNSET, which is what
    ``test_strict_mode_exempts_rebind_batches`` needs (a candidate that makes
    `label` mandatory only mints an issue for an element that lacks it)."""
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_a",
                    "type_name": "Node",
                    "properties": {} if label is None else {"label": label},
                }
            ],
            "message": "seed",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_a"]


def test_migration_batch_lands_atomically(client: TestClient) -> None:
    """The motivating scenario: change the schema AND fix the affected element
    in ONE commit — the model op validated against the NEW schema, one rev,
    one journal row, rebind columns set.

    Direction note (brief deviation, see the task report): the brief wrote
    this as "drop `label` from the schema AND strip it from the element",
    which the engine cannot express — ``_check_patch_keys``/
    ``Model.delete_property`` reject a key the CURRENT (i.e. already
    swapped-in) schema does not declare, and the design spec §1 says so
    outright: "model ops that need the outgoing schema belong in a prior
    commit". The supported direction is the spec's other example — add a
    property and fill it — which additionally PROVES the hoist: patching
    ``owner_name`` is a 422 under V1 and only succeeds because the rebind
    was applied first, even though the client listed it second.
    """
    eid = _create_node(client, "hello")
    mm_token = _acquire_mm(client)
    el_token = _acquire_element(client, eid)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {
                    "kind": "update_element",
                    "id": eid,
                    "properties_patch": {"owner_name": "ada"},
                },
                {"kind": "metamodel.rebind", "blob": MM_V4},
            ],
            "message": "add owner_name",
            "lock_tokens": [mm_token, el_token],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == base + 1
    assert body["rebound"] is True and body["to_metamodel_id"]
    # the new schema is live and the element carries the new property
    session = get_session()
    assert session.metamodel is not None
    assert {p.name for p in session.metamodel.effective_element_properties("Node")} == {
        "label",
        "owner_name",
    }
    assert session.model is not None
    assert session.model.elements[eid].properties["owner_name"] == "ada"
    # journal: ONE row, rebind columns set, ops carry both families
    hist = client.get(papi("/commits"), params={"limit": 1}).json()["commits"][0]
    assert hist["rev"] == base + 1 and hist["is_rebind"] is True
    assert hist["op_count"] == 2


def test_rebind_batch_requires_the_mm_lease(client: TestClient) -> None:
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 409
    assert any(m["resource_id"] == "mm" for m in r.json()["missing"])


def test_rebind_batch_requires_owner(client: TestClient) -> None:
    _seed_second_member("user-2", "user2@example.com", "editor")
    c2 = TestClient(create_app())
    c2.headers.update(OTHER_HEADERS)
    r = c2.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 403


def test_layout_ops_do_not_require_owner(client: TestClient) -> None:
    """Only the REBIND half is owner-gated: a pure rearrange is editor+, the
    same gate ``PUT /metamodel/layout`` used before it retired."""
    _seed_second_member("user-2", "user2@example.com", "editor")
    c2 = TestClient(create_app())
    c2.headers.update(OTHER_HEADERS)
    token = _acquire_mm(c2)
    r = c2.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "metamodel.move_node",
                    "node": "el:Node",
                    "pos": {"x": 1, "y": 2},
                }
            ],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def test_rebind_refused_while_a_peer_holds_a_model_lease(client: TestClient) -> None:
    eid = _create_node(client, "x")
    _seed_second_member("user-2", "user2@example.com", "editor")
    c2 = TestClient(create_app())
    c2.headers.update(OTHER_HEADERS)
    r = c2.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": eid, "mode": "exclusive"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 409
    assert "quiet" in r.json()["detail"]


def test_rebind_allowed_while_the_CALLER_holds_a_model_lease(
    client: TestClient,
) -> None:
    """The quiet-peers guard is scoped to PEERS: a migration batch is expected
    to hold leases on the very elements it is fixing."""
    eid = _create_node(client, "x")
    mm_token = _acquire_mm(client)
    _acquire_element(client, eid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [mm_token],
        },
    )
    assert r.status_code == 200, r.text


def test_two_rebinds_in_one_batch_is_422(client: TestClient) -> None:
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "metamodel.rebind", "blob": MM_V2},
                {"kind": "metamodel.rebind", "blob": MM_V1},
            ],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 422


def test_invalid_candidate_unwinds_cleanly(client: TestClient) -> None:
    """A bad blob 422s and leaves rev, schema and journal untouched."""
    token = _acquire_mm(client)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "metamodel.rebind", "blob": ": not yaml ["}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 422
    session = get_session()
    assert session.model_rev == base
    assert session.metamodel is not None
    assert session.metamodel.effective_element_properties("Node")  # V1 intact
    assert client.get(papi("/metamodel/raw")).json()["blob"] == MM_V1


def test_mid_batch_model_failure_restores_the_old_schema(client: TestClient) -> None:
    """Rebind applies, then a model op hits the mutation boundary: the whole
    batch unwinds — old schema back in memory, rev unchanged.

    The failing op is a patch that is only invalid under the CANDIDATE
    schema (`label` exists in V1, is gone in V2): its 422 therefore also
    proves the model half validated against the swapped-in schema."""
    eid = _create_node(client, "x")
    mm_token = _acquire_mm(client)
    el_token = _acquire_element(client, eid)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "metamodel.rebind", "blob": MM_V2},
                {
                    "kind": "update_element",
                    "id": eid,
                    "properties_patch": {"label": "y"},
                },
            ],
            "message": "",
            "lock_tokens": [mm_token, el_token],
        },
    )
    assert r.status_code == 422
    session = get_session()
    assert session.model_rev == base
    assert session.metamodel is not None
    assert session.metamodel.effective_element_properties("Node")  # V1 restored
    assert session.model is not None
    assert session.model.metamodel is session.metamodel
    # and the durable binding did not move either
    r2 = client.get(papi("/metamodel/raw"))
    assert r2.json()["blob"] == MM_V1
    # no journal row was written for the rejected batch
    hist = client.get(papi("/commits"), params={"limit": 5}).json()["commits"]
    assert all(not c["is_rebind"] for c in hist)


def test_layout_only_commit_is_cheap_and_journalled(client: TestClient) -> None:
    token = _acquire_mm(client)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {
                    "kind": "metamodel.move_node",
                    "node": "el:Node",
                    "pos": {"x": 5, "y": 6},
                }
            ],
            "message": "arrange",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base + 1
    assert r.json()["rebound"] is False
    assert r.json()["to_metamodel_id"] is None
    layout = client.get(papi("/metamodel/layout")).json()
    assert layout["positions"]["el:Node"] == {"x": 5.0, "y": 6.0}
    hist = client.get(papi("/commits"), params={"limit": 1}).json()["commits"][0]
    assert hist["is_rebind"] is False and hist["op_count"] == 1


def test_stale_batch_below_a_rebind_conflicts_unconditionally(
    client: TestClient,
) -> None:
    eid = _create_node(client, "x")
    stale_base = _rev(client)
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    # a peer batch computed at stale_base, touching something unrelated,
    # must still 409: the schema moved under it.
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [
                {"kind": "update_element", "id": eid, "properties_patch": {}},
            ],
            "message": "",
            "lock_tokens": [],
        },
    )
    assert r.status_code == 409
    # This batch carries no lock token, so a bare 409 would ALSO be produced
    # by the in-mutex lock verification; assert on the body so the test can
    # only pass for the reason it claims (the pre-mutex staleness guard).
    assert r.json()["detail"] == "stale base_rev"


def test_strict_mode_exempts_rebind_batches(client: TestClient) -> None:
    """A rebind that mints conformance issues still lands under strict mode
    (Phase 6B: the engine stays inspectable)."""
    _create_node(client)  # no label -> violates the mandatory-label candidate
    from data_rover.api import db as _db
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = _db.get_db()
    s = next(gen)
    try:
        content.set_strict_mode(s, DEFAULT_PROJECT_ID, True)
    finally:
        gen.close()
    get_session().strict_mode = True
    token = _acquire_mm(client)
    # V3 makes `label` mandatory -> the existing element without it is a
    # conformance (multiplicity) issue under the new schema.
    mm_v3 = (
        "elements:\n  - name: Node\n    properties:\n"
        "      - name: label\n        datatype: string\n        multiplicity: '1'\n"
    )
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": mm_v3}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["validation_error_count"] >= 1


def test_strict_mode_still_blocks_a_layout_only_batch_with_issues(
    client: TestClient,
) -> None:
    """The strict-mode exemption is scoped to REBIND batches only — a
    layout-only batch keeps the ordinary gate. Nothing here mints an issue,
    so this pins the shape, not a rejection: it must simply land."""
    get_session().strict_mode = True
    token = _acquire_mm(client)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "metamodel.move_node", "node": "el:Node", "pos": None}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base + 1
