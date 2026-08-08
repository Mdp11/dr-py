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


def _folder_lease(client: TestClient, fid: str, intent: str = "edit") -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _commit_rename(client: TestClient, fid: str, name: str) -> None:
    token = _folder_lease(client, fid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": fid, "name": name}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def _seed_view(client: TestClient, folders: list[dict]) -> dict[str, str]:
    """Build a (possibly nested) folder tree via ``POST /commits`` — the
    commit-flow replacement for the retired ``PUT /view/snapshot`` one-shot
    setup harness these tests used purely to seed named folders with ids.
    *folders* uses the same nested shape the old PUT body did:
    ``[{"name": ..., "folders": [...]}, ...]``. Returns a flat {name: id} map
    (names are unique per test, so a flat map is unambiguous even for
    nested folders). A single ``root`` lease covers the whole batch — ids
    created earlier in the same batch need no lock to be referenced later."""
    ops: list[dict] = []
    counter = 0

    def walk(spec: dict, parent_id: str) -> None:
        nonlocal counter
        counter += 1
        temp_id = f"tmp_{counter}"
        ops.append(
            {
                "kind": "create_folder",
                "temp_id": temp_id,
                "parent_id": parent_id,
                "name": spec["name"],
            }
        )
        for child in spec.get("folders", []):
            walk(child, temp_id)

    for f in folders:
        walk(f, "root")

    token = _folder_lease(client, "root")
    r = client.post(
        papi("/commits"),
        json={"base_rev": _rev(client), "ops": ops, "message": "setup", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    id_map = r.json()["id_map"]
    return {op["name"]: id_map[op["temp_id"]] for op in ops}


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


def test_stale_view_batch_overlapping_tail_409s(client) -> None:
    ids = _seed_view(client, [{"name": "A"}, {"name": "B"}])
    fa = ids["A"]
    stale_base = _rev(client)
    _commit_rename(client, fa, "A2")  # tail commit touching folder:fa
    token = _folder_lease(client, fa)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "rename_folder", "id": fa, "name": "A3"}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "conflicting concurrent commits"


def test_stale_view_batch_disjoint_from_tail_lands(client) -> None:
    ids = _seed_view(client, [{"name": "A"}, {"name": "B"}])
    fa = ids["A"]
    fb = ids["B"]
    stale_base = _rev(client)
    _commit_rename(client, fa, "A2")  # tail touches only folder:fa
    token = _folder_lease(client, fb)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "rename_folder", "id": fb, "name": "B2"}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def test_stale_batch_renaming_delete_folder_subtree_child_409s(client) -> None:
    """Regression for final-review Fix 4a (the two "hardest kinds"):
    ``_affected_ids`` reads BOTH a tail commit's forward AND inverse ops, so
    a ``delete_folder D`` tail commit's cascade victims (here child C) surface
    via the inverse unit's ``create_folder`` ops even though the forward op
    only names D. A stale batch that renames C — never mentioning D at all —
    must still 409."""
    ids = _seed_view(client, [{"name": "D", "folders": [{"name": "C"}]}])
    d_id = ids["D"]
    c_id = ids["C"]
    stale_base = _rev(client)

    delete_token = _folder_lease(client, d_id, intent="delete")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "delete_folder", "id": d_id}],
            "message": "m",
            "lock_tokens": [delete_token],
        },
    )
    assert r.status_code == 200, r.text

    rename_token = _folder_lease(client, c_id)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "rename_folder", "id": c_id, "name": "C2"}],
            "message": "m",
            "lock_tokens": [rename_token],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "conflicting concurrent commits"


def test_stale_batch_creating_under_move_folders_old_parent_409s(client) -> None:
    """Regression for final-review Fix 4a: a ``move_folder F`` tail commit's
    canonical op only names F's DESTINATION parent (B) — its OLD parent (A)
    surfaces only via the commit's own INVERSE op (``move_folder F`` back to
    A), which ``_affected_ids`` also scans. A stale batch that creates a new
    folder under A — the OLD parent, never named by the tail's forward op —
    must still 409."""
    ids = _seed_view(client, [{"name": "A", "folders": [{"name": "F"}]}, {"name": "B"}])
    a_id = ids["A"]
    b_id = ids["B"]
    f_id = ids["F"]
    stale_base = _rev(client)

    # required_locks resolves F's CURRENT parent (A) itself — the op names
    # only the destination (B) — so the leases needed are on A and B, not F.
    move_token = _folder_lease(client, a_id)
    move_token2 = _folder_lease(client, b_id)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "move_folder", "id": f_id, "to_parent_id": b_id}],
            "message": "m",
            "lock_tokens": [move_token, move_token2],
        },
    )
    assert r.status_code == 200, r.text

    create_token = _folder_lease(client, a_id, intent="edit")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [
                {
                    "kind": "create_folder",
                    "temp_id": "tmp_new",
                    "parent_id": a_id,
                    "name": "New",
                }
            ],
            "message": "m",
            "lock_tokens": [create_token],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "conflicting concurrent commits"


def test_stale_delete_folder_batch_hydrates_view_for_overlap_check(client) -> None:
    """Regression for final-review round 3: the pre-mutex overlap check
    (``_batch_touched_ids``, inside the ``base_rev < model_rev`` staleness
    block) resolves its OWN local view — never assigned to ``session.view``,
    since this whole block runs before ``session.write_mutex`` — so a stale
    batch's own ``delete_folder``/``move_folder`` ops are expanded against
    the REAL durable tree, not an unhydrated ``None``.

    The caller's lock is deliberately acquired while the cache is still WARM
    (so ``expand_targets`` correctly grants a token covering the FULL {D, C}
    subtree, not the narrower under-scoped grant round 2's finding covers) —
    this isolates the pre-mutex overlap check as the ONLY thing that could
    catch the conflict: the in-mutex ``required_locks``/``verify_held`` check
    would find the caller's broad token sufficient regardless, so without
    the local hydration fixed here, this batch would silently narrow its
    touched-set to ``{folder:D}`` alone, miss the overlap with the tail's
    rename of child C, sail through the lock check too, and land at 200 —
    not a differently-worded 409, but a genuine lost update. (Verified by
    literally deleting the local's hydration fallback and confirming this is
    the one test in the whole suite that catches it — see the round 3
    report for the exact experiment.)"""
    ids = _seed_view(client, [{"name": "D", "folders": [{"name": "C"}]}])
    d_id = ids["D"]
    c_id = ids["C"]
    stale_base = _rev(client)

    _commit_rename(client, c_id, "C2")  # tail commit touching folder:c only

    # Acquire the caller's DELETE lock on D while session.view is STILL
    # warm (untouched since the setup above) — expand_targets correctly
    # expands over the real subtree here, granting a token covering BOTH
    # D and C (folder ids survive the rename). This is deliberately NOT
    # round 2's narrow-lock repro: the point here is that even a properly
    # broad lock cannot save a stale batch from landing if the PRE-mutex
    # overlap check itself fails to consult the real tree.
    d_token = _folder_lease(client, d_id, intent="delete")

    # NOW the cache goes cold; the durable row (D -> C2) is untouched. Setting
    # session.view directly mirrors exactly what the retired ``DELETE /view``
    # route used to do (clear ONLY the in-memory cache, leaving ViewRow
    # intact) without going through full-session eviction, which the live
    # d_token lease held above would refuse (evict-with-live-locks guard).
    get_session().view = None
    assert client.get(papi("/view")).json()["view"] is None

    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "delete_folder", "id": d_id}],
            "message": "m",
            "lock_tokens": [d_token],
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "conflicting concurrent commits"


def test_placement_subject_overlap_conflicts_across_folders(client) -> None:
    """Two batches fighting over the SAME element's placement conflict even
    though the folders they name are disjoint — the viewel: marker is the
    only thing connecting them (folder leases never collided)."""
    ids = _seed_view(client, [{"name": "A"}, {"name": "C"}])
    fa = ids["A"]
    fc = ids["C"]
    # place e1 in A (a real commit, so the journal carries canonical ops)
    tok = _folder_lease(client, fa)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "place_element", "element_id": "e1", "folder_id": fa}],
            "message": "m",
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    stale_base = _rev(client)
    # tail: remove e1's placement (touches folder:fa + viewel:e1)
    tok = _folder_lease(client, fa)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "remove_element", "element_id": "e1", "folder_id": fa}],
            "message": "m",
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    # stale batch: place e1 into C — folder set {fc} is DISJOINT from the
    # tail's {fa}; only viewel:e1 overlaps. Must 409, not land.
    tok = _folder_lease(client, fc)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": stale_base,
            "ops": [{"kind": "place_element", "element_id": "e1", "folder_id": fc}],
            "message": "m",
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "conflicting concurrent commits"
