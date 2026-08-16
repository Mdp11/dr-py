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
    # NEGATIVE first, so this test proves the hoist on its own rather than in
    # combination with its sibling: the identical patch WITHOUT the rebind is
    # rejected under V1, where `owner_name` does not exist.
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {
                    "kind": "update_element",
                    "id": eid,
                    "properties_patch": {"owner_name": "ada"},
                }
            ],
            "message": "no rebind",
            "lock_tokens": [el_token],
        },
    )
    assert r.status_code == 422, r.text
    assert _rev(client) == base
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


def test_layout_only_batch_lands_under_strict_mode(client: TestClient) -> None:
    """A layout-only batch has an empty dirty scope, so it mints no
    conformance issue and the strict gate is unreachable for it — it simply
    lands. Named for what it actually pins: the gate's SCOPING (exempt when
    ``rebound``, not when ``metamodel_ops``) is proved by
    ``test_strict_mode_blocks_a_mixed_layout_batch_with_issues`` below, which
    is the case where the two conditions differ observably."""
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


def test_strict_mode_blocks_a_mixed_layout_batch_with_issues(
    client: TestClient,
) -> None:
    """The strict-mode exemption is `not rebound`, NOT `not metamodel_ops`:
    a batch carrying layout moves but no rebind keeps the ordinary gate.

    This is the case where the two candidate conditions differ observably —
    the layout-only test above stays green under either spelling because a
    pure layout batch never mints a conformance issue at all.
    """
    eid = _create_node(client, "x")
    get_session().strict_mode = True
    mm_token = _acquire_mm(client)
    el_token = _acquire_element(client, eid)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                # `label` is a string in V1; 123 is a type-conformance issue
                {
                    "kind": "update_element",
                    "id": eid,
                    "properties_patch": {"label": 123},
                },
                {
                    "kind": "metamodel.move_node",
                    "node": "el:Node",
                    "pos": {"x": 9, "y": 9},
                },
            ],
            "message": "",
            "lock_tokens": [mm_token, el_token],
        },
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "strict-mode conformance blocker"
    # full unwind: no rev, and the staged layout row was rolled back too
    assert _rev(client) == base
    assert client.get(papi("/metamodel/layout")).json()["positions"] == {}


def test_swap_is_unwound_when_post_swap_persistence_raises(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression (review Important 1): ``apply_metamodel_ops`` swaps the
    in-memory metamodel and only THEN stages MetamodelRow/ModelRow via
    db.flush(), either of which can raise. ``db.rollback()`` discards the
    staged rows but restores NOTHING in memory, so the unwind handle must be
    registered at the instant of the swap (the ``on_swap`` callback), not from
    the applier's return value. Registering late left the process-wide session
    serving the CANDIDATE schema against a DB still bound to the old one.
    """
    from data_rover.api import metamodel_ops

    before = get_session().metamodel
    assert before is not None
    base = _rev(client)

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("staging blew up")

    # patched on the applier's own module reference, which is what it calls
    monkeypatch.setattr(metamodel_ops.content, "create_metamodel", _boom)
    token = _acquire_mm(client)
    with pytest.raises(RuntimeError):
        client.post(
            papi("/commits"),
            json={
                "base_rev": base,
                "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
                "message": "",
                "lock_tokens": [token],
            },
        )
    session = get_session()
    # the OLD metamodel object is back, identically — not a reparse
    assert session.metamodel is before
    assert session.model is not None
    assert session.model.metamodel is before
    assert before.effective_element_properties("Node")  # V1, not the candidate
    assert session.model_rev == base
    assert session.validation is None  # nulled -> next read re-seeds
    monkeypatch.undo()
    assert client.get(papi("/metamodel/raw")).json()["blob"] == MM_V1


def test_rebind_commit_forces_a_snapshot_at_the_new_rev(client: TestClient) -> None:
    """The forced snapshot is the ONLY thing keeping the replay tail off a
    schema boundary (hydration binds the CURRENT metamodel and would replay
    pre-rebind ops under it), and the periodic policy would not fire here."""
    from data_rover.api import db as _db
    from data_rover.api.session import DEFAULT_PROJECT_ID

    token = _acquire_mm(client)
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    new_rev = base + 1
    gen = _db.get_db()
    s = next(gen)
    try:
        snap = content.latest_snapshot(s, DEFAULT_PROJECT_ID, new_rev)
    finally:
        gen.close()
    assert snap is not None and snap.rev == new_rev


def test_rebind_broadcasts_rebind_event_not_commit_event(client: TestClient) -> None:
    """Peers cannot apply a delta across a schema swap, so a rebound commit
    must emit `rebind_event` INSTEAD of `commit_event`. Nothing else asserts
    that create_commit picks it (test_rebind_event.py only covers the builder
    against the standalone route)."""
    events: list[dict] = []
    session = get_session()
    monkey = session.hub.broadcast
    session.hub.broadcast = events.append  # type: ignore[method-assign]
    try:
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
        assert r.status_code == 200, r.text
    finally:
        session.hub.broadcast = monkey  # type: ignore[method-assign]
    types = [e["type"] for e in events]
    assert "rebind" in types
    assert "commit" not in types
    rebind = next(e for e in events if e["type"] == "rebind")
    assert rebind["rev"] == r.json()["model_rev"]
    assert rebind["to_metamodel_id"] == r.json()["to_metamodel_id"]


def test_layout_only_commit_broadcasts_the_metamodel_layout_scope(
    client: TestClient,
) -> None:
    """An open diagram refetches positions off this scope value; a layout
    commit that reported only the default ["model"] would leave every peer's
    canvas stale."""
    events: list[dict] = []
    session = get_session()
    monkey = session.hub.broadcast
    session.hub.broadcast = events.append  # type: ignore[method-assign]
    try:
        token = _acquire_mm(client)
        r = client.post(
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
    finally:
        session.hub.broadcast = monkey  # type: ignore[method-assign]
    commit = next(e for e in events if e["type"] == "commit")
    assert commit["scope"] == ["metamodel-layout"]


# ---------------------------------------------------------------------------
# Task 6: POST /commits/preview dry-runs metamodel batches
# ---------------------------------------------------------------------------


def test_preview_dry_runs_a_migration_batch(client: TestClient) -> None:
    """Direction note (see the task report): the brief wrote this scenario as
    "drop `label` from the schema + strip it from the element", which is
    inexpressible — the rebind is hoisted first, so by the time the model op
    runs the CANDIDATE schema no longer declares `label` and
    `_check_patch_keys` rejects the patch key (design spec §1: "model ops
    that need the outgoing schema belong in a prior commit"). This mirrors
    ``test_migration_batch_lands_atomically``'s supported direction instead:
    add a mandatory-looking property (``MM_V4``) and patch it in the SAME
    batch — legal only once the rebind has swapped the candidate in, which
    also proves the hoist happens under preview exactly as it does under a
    real commit.
    """
    eid = _create_node(client, "hello")
    base = _rev(client)
    r = client.post(
        papi("/commits/preview"),
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
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["would_block"] is False
    # side-effect free: old schema still live, rev unchanged, raw blob
    # unchanged, and the element's property patch never survived the
    # rollback (owner_name is not even a V1 property, so its presence would
    # itself prove the swap leaked past the preview).
    session = get_session()
    assert session.model_rev == base
    assert session.metamodel is not None
    assert {
        p.name for p in session.metamodel.effective_element_properties("Node")
    } == {"label"}
    assert client.get(papi("/metamodel/raw")).json()["blob"] == MM_V1
    assert session.model is not None
    assert session.model.elements[eid].properties.get("label") == "hello"
    assert "owner_name" not in session.model.elements[eid].properties


def test_preview_422s_a_bad_candidate(client: TestClient) -> None:
    r = client.post(
        papi("/commits/preview"),
        json={"base_rev": _rev(client), "ops": [{"kind": "metamodel.rebind", "blob": ": ["}]},
    )
    assert r.status_code == 422


def test_preview_restores_schema_when_model_ops_fail_mid_preview(
    client: TestClient,
) -> None:
    """Proves the restore holds when ``_apply_batch`` itself raises mid-preview
    (a mutation-boundary error), not only on the happy path where the model
    ops succeed and only validation surfaces issues afterward. Mirrors
    ``test_mid_batch_model_failure_restores_the_old_schema`` for the commit
    route: rebind to V2 (which drops `label`), then patch `label` on the
    existing element — legal under V1, a mutation-boundary 422 under the
    swapped-in V2 candidate. That 422 has to propagate THROUGH the preview
    route's ``finally``, so the schema/model/rev restore is exercised on the
    exception path, not just the normal return path.
    """
    eid = _create_node(client, "x")
    base = _rev(client)
    r = client.post(
        papi("/commits/preview"),
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
        },
    )
    assert r.status_code == 422, r.text
    session = get_session()
    assert session.model_rev == base
    assert session.metamodel is not None
    assert session.metamodel.effective_element_properties("Node")  # V1 restored
    assert session.model is not None
    assert session.model.metamodel is session.metamodel
    assert session.model.elements[eid].properties["label"] == "x"
    assert client.get(papi("/metamodel/raw")).json()["blob"] == MM_V1


# ---------------------------------------------------------------------------
# Task 7: POST /model/undo — layout ops replay; rebind batches refuse cleanly
# ---------------------------------------------------------------------------


def test_undo_restores_layout_positions(client: TestClient) -> None:
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "metamodel.move_node", "node": "el:Node", "pos": {"x": 5, "y": 6}}
            ],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    layout = client.get(papi("/metamodel/layout")).json()
    assert "el:Node" not in layout["positions"]  # prior state: key absent


def test_undo_refuses_rebind_batches_and_keeps_history(client: TestClient) -> None:
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
    assert r.status_code == 200, r.text
    r = client.post(papi("/model/undo"))
    assert r.status_code == 409
    # push-back: a second undo attempt hits the same refusal, not "Nothing to undo"
    r = client.post(papi("/model/undo"))
    assert r.status_code == 409
    assert "metamodel" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Final whole-branch review: the preview owner gate + the orphan-DB-state
# commit's unwind
# ---------------------------------------------------------------------------


def test_viewer_may_preview_an_ordinary_batch(client: TestClient) -> None:
    """The gate added below must be the REBIND ARM ONLY. ``/commits/preview``
    is a read-only POST (``authz._READ_ONLY_POST_SUFFIXES``) precisely so any
    member can see what a batch would do before proposing it; a viewer
    previewing model ops keeps working exactly as before."""
    eid = _create_node(client, "hello")
    _seed_second_member("viewer-1", "viewer1@example.com", "viewer")
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "update_element",
                    "id": eid,
                    "properties_patch": {"label": "bye"},
                }
            ],
        },
        headers={"x-user-id": "viewer-1", "x-user-email": "viewer1@example.com"},
    )
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("role", ["viewer", "editor"])
def test_non_owner_rebind_preview_is_403(client: TestClient, role: str) -> None:
    """A rebind preview does the same O(model) work a rebind commit does — two
    ``indexes.rebuild()`` sweeps plus a full ``Scope.all()`` validation, all
    under ``session.write_mutex`` — so it carries the same owner gate
    ``create_commit`` applies to the op itself. Without it any member (a
    VIEWER included) can block every commit in the project at will."""
    user = f"{role}-1"
    _seed_second_member(user, f"{user}@example.com", role)
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": MM_V2}],
        },
        headers={"x-user-id": user, "x-user-email": f"{user}@example.com"},
    )
    assert r.status_code == 403, r.text
    assert "owner" in r.json()["detail"]


def test_orphan_db_commit_failure_unwinds_the_batch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The layout-only branch that commits orphan DB state on a project with
    no durable model row must unwind like every other persist step.

    ``_persist_commit`` is stubbed to report "nothing journalled" (the
    in-memory-only project's shape) so the route reaches its
    ``if (artifact_ops or view_ops or metamodel_ops) and not persisted:``
    branch, and the DB session's ``commit`` is made to raise there. Without
    the try/except the raise escapes with ``model_rev`` already bumped and
    the batch already in ``op_log``.
    """
    import sqlalchemy.orm as sa_orm

    import data_rover.api.routes.commits as commits_mod

    session = get_session()
    token = _acquire_mm(client)
    base = _rev(client)
    log_depth = len(session.op_log)

    monkeypatch.setattr(commits_mod, "_persist_commit", lambda *a, **k: False)

    def _boom(self: object) -> None:
        raise RuntimeError("db down")

    monkeypatch.setattr(sa_orm.Session, "commit", _boom)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "metamodel.move_node", "node": "el:Node", "pos": {"x": 1, "y": 2}}
            ],
            "message": "",
            "lock_tokens": [token],
        },
    )
    monkeypatch.undo()  # before the assertions below re-read through the DB

    assert r.status_code == 500, r.text
    assert session.model_rev == base  # rev bump unwound
    assert len(session.op_log) == log_depth  # batch not left undoable
