"""Route-level tests: a commit evicts exactly the cells whose read-sets it
touches; the legacy flag and the no-delta paths still clear everything."""

from __future__ import annotations

import random
from typing import Literal, cast

import pytest
from fastapi.testclient import TestClient

from data_rover.api.invalidation import touched_keys
from data_rover.api.main import create_app
from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import OPS_ADAPTER
from data_rover.api.session import Session, get_session
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.script.cell_cache import ScriptCellCache
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import CallResult, RunLimits, ScriptBudget

from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""

#: A metamodel with a containment relationship, used only by the
#: structural-reject test below (two containment parents is a STRUCTURAL
#: issue — see core/validation/validators/containment.py).
CONTAINMENT_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    mappings:
      - source: Node
        target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _seed(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel"),
        content=THING_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "t1", "type_name": "Thing", "properties": {"name": "One"}},
                {"id": "t2", "type_name": "Thing", "properties": {"name": "Two"}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text


def _res(v: str) -> CallResult:
    return CallResult(value={"kind": "scalar", "value": v}, error=None, duration_ms=1)


KEY_T1 = ("a" * 64, "value", ("t1",))
KEY_T2 = ("a" * 64, "value", ("t2",))


def _prime_cells(session: Session) -> int:
    rev = session.model_rev
    session.script_cell_cache.clear_and_stamp(rev)
    session.script_cell_cache.put(
        KEY_T1, _res("One"), rev, reads=frozenset({("el", "t1")})
    )
    session.script_cell_cache.put(
        KEY_T2, _res("Two"), rev, reads=frozenset({("el", "t2")})
    )
    return rev


def _update_t1(client: TestClient, rev: int) -> int:
    r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": "t1",
                    "properties_patch": {"name": "One!"},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["model_rev"]


def _lock(client: TestClient, targets: list[tuple[str, str]]) -> str:
    """Acquire one token covering every ``(resource_id, mode)`` in *targets*."""
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": rid, "mode": mode} for rid, mode in targets],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_ops_commit_evicts_only_touched_cells(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    new_rev = _update_t1(client, rev)
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    hit = session.script_cell_cache.get(KEY_T2, new_rev)
    assert hit is not None and hit.value == {"kind": "scalar", "value": "Two"}


def test_undo_also_evicts_selectively(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    _update_t1(client, session.model_rev)  # something to undo
    rev = _prime_cells(session)
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    new_rev = r.json()["model_rev"]
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None  # undo touched t1
    assert session.script_cell_cache.get(KEY_T2, new_rev) is not None


def test_flag_off_restores_clear_all(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_ROVER_SNIPPET_INCREMENTAL_INVALIDATION", "false")
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    new_rev = _update_t1(client, rev)
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    assert session.script_cell_cache.get(KEY_T2, new_rev) is None


def test_legacy_touch_model_still_clears_all(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    _prime_cells(session)
    session.touch_model()
    assert session.script_cell_cache.size == 0


def test_commit_evicts_only_touched_cells_and_preserves_others(
    client: TestClient,
) -> None:
    """POST /commits (the durable, lock-verified path) must apply the same
    selective eviction as /model/ops — an untouched cell must SURVIVE at the
    new rev, not merely be absent from the touched set."""
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    token = _lock(client, [("t1", "exclusive")])
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": "t1",
                    "properties_patch": {"name": "One!"},
                }
            ],
            "lock_tokens": [token],
            "message": "touch t1",
        },
    )
    assert r.status_code == 200, r.text
    new_rev = r.json()["model_rev"]
    assert new_rev == rev + 1
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    hit = session.script_cell_cache.get(KEY_T2, new_rev)
    assert hit is not None and hit.value == {"kind": "scalar", "value": "Two"}


def test_commit_structural_reject_leaves_cache_fully_cleared(
    client: TestClient,
) -> None:
    """A structural-reject 422 sits on its own rollback branch (distinct from
    the accepted-commit branch above) and must keep using clear-all rather
    than drifting onto the selective call."""
    r = client.post(
        papi("/metamodel"),
        content=CONTAINMENT_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "p1", "type_name": "Node", "properties": {}},
                {"id": "p2", "type_name": "Node", "properties": {}},
                {"id": "child", "type_name": "Node", "properties": {}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    session = get_session()
    rev = _prime_cells(session)
    token = _lock(
        client,
        [("p1", "exclusive"), ("p2", "exclusive"), ("child", "exclusive")],
    )
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "create_relationship",
                    "temp_id": "tmp_r1",
                    "type_name": "Contains",
                    "source_id": "p1",
                    "target_id": "child",
                    "properties": {},
                },
                {
                    "kind": "create_relationship",
                    "temp_id": "tmp_r2",
                    "type_name": "Contains",
                    "source_id": "p2",
                    "target_id": "child",
                    "properties": {},
                },
            ],
            "lock_tokens": [token],
            "message": "two parents",
        },
    )
    assert r.status_code == 422, r.text
    assert r.json()["structural_blockers"]
    assert session.script_cell_cache.size == 0


# --------------------------------------------------------------------------
# Randomized end-to-end soundness property test (Task 10).
#
# The route-level tests above pin exact touched-key sets for individual op
# kinds; this test instead throws a long randomized sequence of batches (any
# mix of update/create/delete/connect/disconnect) at a live model, evicts the
# cell cache selectively after each one via the REAL `touched_keys` +
# `evict_touched` path, and after every single round asserts that EVERY cell
# still resident in the cache (i.e. every surviving cache entry, not just the
# ones the test happens to expect) equals a fresh, cache-less recompute
# against the model as it stands right now. A surviving cell that diverges
# from a fresh recompute is a real soundness bug: either `touched_keys` failed
# to report a key that some cell's read-set should have intersected with, or
# the facade under-recorded a read (`CallResult.reads`) that the cell's
# computation actually depended on. Either way, fix it AT THE SOURCE
# (`src/data_rover/api/invalidation.py` or
# `src/data_rover/core/script/facade_src.py`) — never by weakening this test.
# --------------------------------------------------------------------------

SNIPPET_NAME = "def value(els):\n    return els[0].get('name', '?')\n"
SNIPPET_HOPS = (
    "def value(els):\n"
    "    return ','.join(sorted(r['target_id'] for r in els[0].out()))\n"
)
SNIPPET_SCAN = (
    "def value(els):\n"
    "    return sum(1 for _ in dr.elements(type='Thing'))\n"
)
SNIPPETS = [SNIPPET_NAME, SNIPPET_HOPS, SNIPPET_SCAN]


def _prop_mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Thing",
                properties=[PropertyDef(name="name", datatype="string")],
            )
        ],
        relationships=[
            RelationshipType(name="Link", source="Thing", target="Thing")
        ],
    )


def _random_batch(rng: random.Random, model: Model) -> list[dict]:
    ids = sorted(model.elements)
    kind = rng.choice(["update", "create", "delete", "connect", "disconnect"])
    if kind == "update" and ids:
        return [
            {
                "kind": "update_element",
                "id": rng.choice(ids),
                "properties_patch": {"name": f"n{rng.randrange(1000)}"},
            }
        ]
    if kind == "create":
        return [
            {
                "kind": "create_element",
                "temp_id": f"tmp_{rng.randrange(10**6)}",
                "type_name": "Thing",
                "properties": {"name": "new"},
            }
        ]
    if kind == "delete" and len(ids) > 2:
        return [{"kind": "delete_element", "id": rng.choice(ids)}]
    if kind == "connect" and len(ids) >= 2:
        s, t = rng.sample(ids, 2)
        return [
            {
                "kind": "create_relationship",
                "temp_id": f"tmp_{rng.randrange(10**6)}",
                "type_name": "Link",
                "source_id": s,
                "target_id": t,
                "properties": {},
            }
        ]
    rel_ids = sorted(model.relationships)
    if kind == "disconnect" and rel_ids:
        return [{"kind": "delete_relationship", "id": rng.choice(rel_ids)}]
    return [
        {
            "kind": "create_element",
            "temp_id": f"tmp_{rng.randrange(10**6)}",
            "type_name": "Thing",
            "properties": {"name": "fallback"},
        }
    ]


def _fill_cache(model: Model, cache: ScriptCellCache, rev: int) -> dict[str, str]:
    """Compute every (snippet x element) cell through the eval context (so
    read-sets flow into the cache) and return sha->code for verification."""
    ctx = ScriptEvalContext(
        TrustedRunner(),
        model,
        RunLimits(),
        ScriptBudget.start(300),
        cell_cache=cache,
        rev=rev,
    )
    try:
        import hashlib

        sha_to_code: dict[str, str] = {}
        for code in SNIPPETS:
            sha_to_code[hashlib.sha256(code.encode()).hexdigest()] = code
            for eid in sorted(model.elements):
                res = ctx.call(code, "value", [eid])
                assert res.error is None, (code, eid, res.error)
    finally:
        ctx.close()
    return sha_to_code


def test_surviving_cells_equal_fresh_recompute() -> None:
    rng = random.Random(20260721)
    model = Model(_prop_mm())
    for i in range(6):
        e = model.restore_element(f"e{i}", "Thing")
        model.set_property(e, "name", f"N{i}")
    model.connect("Link", "e0", "e1")
    model.connect("Link", "e1", "e2")

    cache = ScriptCellCache(cap=1000)
    rev = 1
    cache.clear_and_stamp(rev)
    sha_to_code = _fill_cache(model, cache, rev)

    for _round in range(25):
        batch = _random_batch(rng, model)
        res = _apply_batch(model, OPS_ADAPTER.validate_python(batch), restore=False)
        rev += 1
        touched = touched_keys(model, model.metamodel, res)
        if touched is None:
            cache.clear_and_stamp(rev)
        else:
            cache.evict_touched(touched, rev)

        # Every surviving cell must equal a fresh, cache-less recompute.
        verify = ScriptEvalContext(
            TrustedRunner(), model, RunLimits(), ScriptBudget.start(300)
        )
        try:
            for (sha, entry, ids), (cached, _reads) in list(cache._d.items()):
                # `CellKey`'s `entry` field is a plain `str` (it round-trips
                # through the cache verbatim); every entry this test ever
                # writes is `"value"` (see `SNIPPETS`/`_fill_cache`), so the
                # cast is a type-level formality, not a runtime assumption.
                fresh = verify.call(
                    sha_to_code[sha], cast(Literal["value", "step"], entry), list(ids)
                )
                assert fresh.error is None, fresh.error
                assert fresh.value == cached.value, (
                    f"round {_round}: stale survivor {sha[:8]}/{ids} "
                    f"cached={cached.value} fresh={fresh.value} batch={batch}"
                )
        finally:
            verify.close()

        sha_to_code = _fill_cache(model, cache, rev)  # refill for next round
