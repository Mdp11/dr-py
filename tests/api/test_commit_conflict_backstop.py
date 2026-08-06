"""The generalized staleness rule: non-overlapping concurrent commits land;
overlapping ones 409. Leases make conflicts rare — this is the backstop.

Also covers the fail-closed fallbacks that keep the rule sound when the
durable journal does NOT fully explain the gap between ``base_rev`` and
head: an unjournaled rev bump (legacy mutation routes / apply-cr), a
``persist_baseline`` empty-ops marker (model upload/clear), a rebind, and a
project with no durable journal at all.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""

_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Link
    source: Widget
    target: Widget
"""

SNIP = {"schema_version": 1, "language": "python",
        "code": "def value(el):\n    return 1\n"}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def _commit(c: TestClient, ops: list[dict], base_rev: int):
    return c.post(papi("/commits"),
                  json={"base_rev": base_rev, "ops": ops, "lock_tokens": []})


def _lock(c: TestClient, resource_id: str, *, type_: str = "element") -> str:
    """Acquire an exclusive lease on *resource_id* and return the token."""
    r = c.post(
        papi("/locks"),
        json={"targets": [{"resource_id": resource_id, "mode": "exclusive", "type": type_}],
              "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_non_overlapping_stale_commit_lands(client: TestClient) -> None:
    base = _rev(client)  # both clients start here
    r1 = _commit(client, [{"kind": "create_element", "temp_id": "tmp_a",
                           "type_name": "Node", "properties": {}}], base)
    assert r1.status_code == 200, r1.text
    # second client, still at the old base, touches a DIFFERENT resource
    r2 = _commit(client, [{"kind": "create_artifact", "temp_id": "tmp_b",
                           "artifact_kind": "code_snippet", "name": "s",
                           "payload": SNIP}], base)
    assert r2.status_code == 200, r2.text          # would have been 409 before


def test_non_overlapping_stale_commit_with_real_touched_ids_lands(client: TestClient) -> None:
    """Strengthens the test above, whose second batch (``create_artifact``)
    has an EMPTY touched set and so would pass even with conflict detection
    disabled entirely. Here both batches have a genuinely non-empty,
    DISJOINT touched set: two elements, two independent updates."""
    r = _commit(client, [
        {"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node", "properties": {}},
        {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Node", "properties": {}},
    ], _rev(client))
    assert r.status_code == 200, r.text
    id_map = r.json()["id_map"]
    aid, bid = id_map["tmp_a"], id_map["tmp_b"]
    base = _rev(client)

    tok_a = _lock(client, aid)
    r1 = client.post(papi("/commits"), json={
        "base_rev": base,
        "ops": [{"kind": "update_element", "id": aid, "properties_patch": {}}],
        "lock_tokens": [tok_a],
    })
    assert r1.status_code == 200, r1.text

    # second writer, still at `base`, touches the OTHER element -> lands
    tok_b = _lock(client, bid)
    r2 = client.post(papi("/commits"), json={
        "base_rev": base,
        "ops": [{"kind": "update_element", "id": bid, "properties_patch": {}}],
        "lock_tokens": [tok_b],
    })
    assert r2.status_code == 200, r2.text


def test_relationship_id_overlap_conflicts(client: TestClient) -> None:
    """Model-op overlap coverage (the artifact path was the only one
    exercised before this fix): a relationship delete/update's CANONICAL op
    carries only its OWN id, never a ``source_id`` — so ``required_locks``
    alone (which derives just the source element's lock) cannot detect a
    same-relationship conflict once the first writer has already deleted it
    out of the model (its source can no longer be resolved). This exercises
    the explicit id re-add in ``_batch_touched_ids`` for
    Update/DeleteRelationshipOp — without it, this test would wrongly land
    r2 at 200 (or a 422 from the mutation boundary), never a clean 409."""
    base = _rev(client)
    r = _commit(client, [
        {"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node", "properties": {}},
        {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Node", "properties": {}},
        {"kind": "create_relationship", "temp_id": "tmp_r", "type_name": "Link",
         "source_id": "tmp_a", "target_id": "tmp_b", "properties": {}},
    ], base)
    assert r.status_code == 200, r.text
    id_map = r.json()["id_map"]
    aid, rid = id_map["tmp_a"], id_map["tmp_r"]
    base2 = _rev(client)

    tok = _lock(client, aid)  # relationship locks route through the SOURCE element
    r1 = client.post(papi("/commits"), json={
        "base_rev": base2,
        "ops": [{"kind": "delete_relationship", "id": rid}],
        "lock_tokens": [tok],
    })
    assert r1.status_code == 200, r1.text

    # second writer, still at base2, targets the SAME (now-deleted) relationship
    r2 = client.post(papi("/commits"), json={
        "base_rev": base2,
        "ops": [{"kind": "update_relationship", "id": rid, "properties_patch": {}}],
        "lock_tokens": [tok],
    })
    assert r2.status_code == 409
    assert r2.json()["detail"] == "conflicting concurrent commits"


def test_overlapping_stale_commit_409(client: TestClient) -> None:
    """Deterministic version of the brief's sample: the update path always
    requires an ``art:`` lease (Task 5), so both writers acquire one up
    front rather than branching on whether the route demanded it."""
    r = _commit(client, [{"kind": "create_artifact", "temp_id": "tmp_b",
                          "artifact_kind": "code_snippet", "name": "s",
                          "payload": SNIP}], _rev(client))
    assert r.status_code == 200, r.text
    aid = r.json()["id_map"]["tmp_b"]
    base = _rev(client)

    tok1 = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": aid, "mode": "exclusive", "type": "artifact"}],
              "intent": "edit"},
    ).json()["token"]
    r1 = client.post(
        papi("/commits"),
        json={"base_rev": base,
              "ops": [{"kind": "update_artifact", "id": aid,
                       "payload": {**SNIP, "code": "a = 1"}}],
              "lock_tokens": [tok1]},
    )
    assert r1.status_code == 200, r1.text

    # a second writer still at `base` touching the SAME artifact -> 409
    tok2 = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": aid, "mode": "exclusive", "type": "artifact"}],
              "intent": "edit"},
    ).json()["token"]
    r2 = client.post(
        papi("/commits"),
        json={"base_rev": base,
              "ops": [{"kind": "update_artifact", "id": aid,
                       "payload": {**SNIP, "code": "b = 2"}}],
              "lock_tokens": [tok2]},
    )
    assert r2.status_code == 409
    assert r2.json()["detail"] == "conflicting concurrent commits"


def test_future_base_rev_still_409(client: TestClient) -> None:
    r = _commit(client, [], _rev(client) + 5)
    assert r.status_code == 409


def test_short_tail_from_unjournaled_mutation_409(client: TestClient) -> None:
    """A legacy PATCH mutates the model OUTSIDE the ops/commit protocol:
    ``Session.touch_model()`` bumps ``model_rev`` but writes NO ``Commit``
    row at all. The tail is then too SHORT to explain the gap, so a stale
    batch must fail closed even though its own touched id never appears
    anywhere in the (empty) tail — there is nothing to inspect for that rev."""
    r = _commit(client, [{"kind": "create_element", "temp_id": "tmp_a",
                          "type_name": "Node", "properties": {}}], _rev(client))
    assert r.status_code == 200, r.text
    aid = r.json()["id_map"]["tmp_a"]
    base = _rev(client)

    r_patch = client.patch(papi(f"/model/elements/{aid}"), json={"properties": {}})
    assert r_patch.status_code == 200, r_patch.text

    r2 = _commit(client, [{"kind": "create_element", "temp_id": "tmp_z",
                           "type_name": "Node", "properties": {}}], base)
    assert r2.status_code == 409
    assert r2.json()["detail"] == "stale base_rev"


def test_baseline_reset_after_upload_always_conflicts(client: TestClient) -> None:
    """``POST /model/upload`` replaces the whole model and (Task 9) calls
    ``persist_baseline``: history is cleared and ONE marker commit with
    EMPTY ops is written at the new rev. The tail fully accounts for the rev
    gap (one row, one rev, so the short-tail check does NOT catch it), but
    names no resources at all — the dedicated empty-ops-in-tail branch must
    catch it, or a stale batch would silently land against a
    wholesale-replaced model."""
    r = _commit(client, [{"kind": "create_element", "temp_id": "tmp_a",
                          "type_name": "Node", "properties": {}}], _rev(client))
    assert r.status_code == 200, r.text
    base = _rev(client)

    r_up = client.post(papi("/model/upload"),
                        content=b'{"elements":[],"relationships":[]}')
    assert r_up.status_code == 200, r_up.text

    r2 = _commit(client, [{"kind": "create_element", "temp_id": "tmp_z",
                           "type_name": "Node", "properties": {}}], base)
    assert r2.status_code == 409
    assert r2.json()["detail"] == "stale base_rev"


def test_rebind_in_tail_always_conflicts(client: TestClient) -> None:
    """A rebind fully accounts for the rev gap (one row) and is not
    empty-ops (it carries the retype), so neither of the other two
    fallbacks catches it — its own dedicated check must, since the client's
    ops were computed against a metamodel that no longer exists."""
    base = _rev(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={base}&message=swap",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text

    r2 = _commit(client, [], base)
    assert r2.status_code == 409
    assert r2.json()["detail"] == "stale base_rev"


def test_no_durable_journal_keeps_strict_rule() -> None:
    """A project with no durable ``ModelRow`` (never uploaded its metamodel
    through the durable-persisting route) has no journal to inspect the gap
    against, so it keeps the PRE-generalization strict-equality rule: ANY
    stale ``base_rev`` 409s, even for a batch that would not have overlapped."""
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    # Set up the session directly (bypassing the /metamodel HTTP route,
    # which is what creates the durable ModelRow) so get_request_session
    # resolves the SAME in-memory Session with model+metamodel set but no
    # backing DB content row — the in-memory-only legacy shape.
    from data_rover.core.metamodel.loader import load_metamodel_str
    from data_rover.core.model.model import Model

    session = get_session()
    session.metamodel = load_metamodel_str(_MM)
    session.set_model(Model(session.metamodel))

    base = _rev(c)
    r1 = _commit(c, [{"kind": "create_element", "temp_id": "tmp_a",
                      "type_name": "Node", "properties": {}}], base)
    assert r1.status_code == 200, r1.text
    # a second, non-overlapping batch at the same stale base still 409s:
    # there is no journal to prove it didn't overlap.
    r2 = _commit(c, [{"kind": "create_element", "temp_id": "tmp_c",
                      "type_name": "Node", "properties": {}}], base)
    assert r2.status_code == 409
    assert r2.json()["detail"] == "stale base_rev"


def test_empty_commit_is_a_no_op_and_never_poisons_the_tail(
    client: TestClient,
) -> None:
    """A message-only "checkpoint" commit must not burn a rev (final-review
    finding 4). An empty-ops journal row IS ``persist_baseline``'s marker for
    "the whole model was replaced opaquely", so writing one here would turn
    every later stale base_rev into an unconditional 409 forever — permanently
    disabling the overlap rule this module tests. Mirrors ``apply_ops``' own
    empty-batch early return."""
    base = _rev(client)
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": [], "lock_tokens": [], "message": "checkpoint"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base
    assert _rev(client) == base
    assert client.get(papi("/commits")).json()["commits"] == []  # no journal row

    # the overlap rule still works afterwards: a stale, DISJOINT batch lands
    r1 = _commit(client, [{"kind": "create_element", "temp_id": "tmp_a",
                           "type_name": "Node", "properties": {}}], base)
    assert r1.status_code == 200, r1.text
    r2 = _commit(client, [{"kind": "create_element", "temp_id": "tmp_b",
                           "type_name": "Node", "properties": {}}], base)
    assert r2.status_code == 200, r2.text


def test_id_keys_are_derived_from_the_op_models() -> None:
    """The touched-set scan over RAW journal dicts cannot use ``assert_never``
    (it never sees typed ops), so its id-bearing field names must be DERIVED
    from the op models instead of hand-maintained — otherwise a new op kind,
    or a new id field on an existing one, silently contributes nothing to the
    conflict backstop and a real conflict becomes a lost update."""
    from typing import Literal

    from pydantic import BaseModel

    from data_rover.api.routes.commits import (
        _ARTIFACT_ID_KEYS,
        _MODEL_ID_KEYS,
        _id_field_names,
    )

    assert _MODEL_ID_KEYS == frozenset({"id", "temp_id", "source_id", "target_id"})
    assert _ARTIFACT_ID_KEYS == frozenset({"id", "temp_id"})

    class _FutureOp(BaseModel):
        kind: Literal["future_op"]
        id: str
        owner_id: str  # a new id-bearing field on a future op kind
        label: str

    assert _id_field_names((_FutureOp,)) == frozenset({"id", "owner_id"})
