"""The head tables (``elements``, ``relationships``, ``entity_refs`` and the
``ModelRow`` columns) are written by every path that changes the model, and equal
a full model after each one: same entities in the same order, the same
``entity_refs`` as the model's referencer index, the same counts and digest. That
model is replayed here from the project's rev-0 snapshot and its journal, the way
the rows never are.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from data_rover.api import content, db, head as head_mod, importer, tenancy
from data_rover.api.db_models import (
    ElementRow,
    EntityRefRow,
    ModelRow,
    Project,
    RelationshipRow,
)
from data_rover.api.main import create_app
from data_rover.api.artifact_ops import split_ops
from data_rover.api.project_state import DEFAULT_PROJECT_ID, get_registry
from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import deserialize_ops
from data_rover.api.snapshot_codec import decode_snapshot
from data_rover.api.storage import get_snapshot_store
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

from .conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    SMART_CITY_MM,
    SMART_CITY_MODEL,
    commit_ops,
    default_state,
    head,
    install,
    papi,
    post_commit,
    seed_default_project,
)
from .test_commits_metamodel_ops import _acquire_mm

_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
      - {name: n, datatype: integer}
      - {name: x, datatype: float}
      - {name: ref, datatype: Node}
      - {name: refs, datatype: Node, multiplicity: "0..*"}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
  - name: Link
    source: Node
    target: Node
    properties:
      - {name: via, datatype: Node}
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


@contextmanager
def _db() -> Iterator[DbSession]:
    gen = db.get_db()
    s = next(gen)
    try:
        yield s
    finally:
        gen.close()


def _replayed_model(s: DbSession, project_id: str) -> Model:
    """The full model the journal says the project holds: the rev-0 snapshot (an
    empty model when the project has none), then every commit after it applied in
    restore mode, a rebind switching the metamodel at its commit."""
    row = content.get_model_row(s, project_id)
    assert row is not None
    snap = content.get_snapshot(s, project_id, 0)
    mm_id = snap.metamodel_id if snap is not None else row.metamodel_id
    assert mm_id is not None
    mm_row = content.get_metamodel_row(s, mm_id)
    assert mm_row is not None
    metamodel = load_metamodel_str(mm_row.blob)
    if snap is None:
        model = Model(metamodel)
    else:
        raw = decode_snapshot(get_snapshot_store().get(snap.key))
        model = build_model_from_dicts(metamodel, raw, strict=False)
    for commit in content.commits_after(s, project_id, 0):
        if commit.to_metamodel_id is not None:
            to_row = content.get_metamodel_row(s, commit.to_metamodel_id)
            assert to_row is not None
            model.metamodel = load_metamodel_str(to_row.blob)
            model.indexes.rebuild()
        ops = split_ops(deserialize_ops(commit.ops))[0]
        if ops:
            _apply_batch(model, ops, restore=True)
    return model


def _assert_rows_equal_replay(project_id: str = DEFAULT_PROJECT_ID) -> None:
    """Every head table equals the model replayed from the journal."""
    with _db() as s:
        model = _replayed_model(s, project_id)
        want_e = [asdict(e) for e in model.elements.values()]
        want_r = [asdict(r) for r in model.relationships.values()]
        want_refs = {(r, t) for t, rs in model.indexes.ref_targets.items() for r in rs}
        want_digest = model_digest(model)
        got_e, got_r = head_mod.read_head(s, project_id)
        got_refs = {
            (r, t)
            for r, t in s.execute(
                select(EntityRefRow.referencer_id, EntityRefRow.target_id).where(
                    EntityRefRow.project_id == project_id
                )
            )
        }
        row = content.get_model_row(s, project_id)
        assert row is not None
        s.refresh(row)
        assert got_e == want_e
        assert got_r == want_r
        assert got_refs == want_refs
        assert row.element_count == len(want_e)
        assert row.relationship_count == len(want_r)
        assert row.state_digest == want_digest
        assert row.next_seq is not None
        for table in (ElementRow, RelationshipRow):
            top = s.execute(
                select(func.max(table.seq)).where(table.project_id == project_id)
            ).scalar_one()
            assert top is None or top < row.next_seq


def test_install_writes_rows_in_model_order() -> None:
    install()
    _assert_rows_equal_replay()
    with _db() as s:
        n_elements, n_relationships = (
            len(t) for t in head_mod.read_head(s, DEFAULT_PROJECT_ID)
        )
        assert n_elements > 0 and n_relationships > 0
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        # baseline: seq 0..n-1 in each table, one allocation counter above both
        seqs = (
            s.execute(
                select(ElementRow.seq)
                .where(ElementRow.project_id == DEFAULT_PROJECT_ID)
                .order_by(ElementRow.seq)
            )
            .scalars()
            .all()
        )
        assert seqs == list(range(n_elements))
        assert row.next_seq == max(n_elements, n_relationships)


def test_reinstall_replaces_the_rows() -> None:
    install()
    install(metamodel=_MM, model=EMPTY_MODEL)
    _assert_rows_equal_replay()
    with _db() as s:
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == ([], [])
        assert (
            s.execute(select(func.count()).select_from(EntityRefRow)).scalar_one() == 0
        )


# --- randomized commits -----------------------------------------------------


def _random_ops(
    rng: random.Random, entity_ids: tuple[list[str], list[str]]
) -> list[dict]:
    els, rels = entity_ids
    ops: list[dict] = []
    fresh = 0
    dead: set[str] = set()

    def props() -> dict[str, Any]:
        out: dict[str, Any] = {}
        live = [e for e in els if e not in dead]
        if rng.random() < 0.6:
            out["label"] = rng.choice(["a", "b", "c", "é中"])
        if rng.random() < 0.3:
            out["n"] = rng.choice([1, 2**60, -7])
        if rng.random() < 0.3:
            out["x"] = rng.choice([1.0, 0.5, 2.0])
        if live and rng.random() < 0.4:
            out["ref"] = rng.choice(live)
        if live and rng.random() < 0.4:
            out["refs"] = rng.sample(live, rng.randint(1, min(3, len(live))))
        return out

    for _ in range(rng.randint(1, 3)):
        live = [e for e in els if e not in dead]
        kind = rng.choice(
            [
                "create",
                "create",
                "create",
                "update",
                "update",
                "delete",
                "link",
                "contain",
                "unlink",
                "recreate_element",
                "recreate_rel",
                "update_rel",
            ]
        )
        if kind == "create" or not live:
            fresh += 1
            eid = f"e{rng.randrange(10**6)}-{len(els)}-{fresh}"
            ops.append(
                {
                    "kind": "create_element",
                    "temp_id": f"tmp_{eid}",
                    "id": eid,
                    "type_name": "Node",
                    "properties": props(),
                }
            )
            els.append(eid)
        elif kind == "update":
            patch = props()
            if rng.random() < 0.4:
                patch["ref"] = None
            if not patch:
                patch["label"] = "z"
            ops.append(
                {
                    "kind": "update_element",
                    "id": rng.choice(live),
                    "properties_patch": patch,
                }
            )
        elif kind == "delete":
            eid = rng.choice(live)
            ops.append({"kind": "delete_element", "id": eid})
            dead.add(eid)
        elif kind in ("link", "contain"):
            fresh += 1
            rid = f"r{rng.randrange(10**6)}-{len(rels)}-{fresh}"
            op: dict[str, Any] = {
                "kind": "create_relationship",
                "temp_id": f"tmp_{rid}",
                "id": rid,
                "type_name": "Link" if kind == "link" else "Contains",
                "source_id": rng.choice(live),
                "target_id": rng.choice(live),
            }
            if kind == "link" and rng.random() < 0.5:
                op["properties"] = {"via": rng.choice(live)}
            ops.append(op)
            rels.append(rid)
        elif kind == "unlink" and rels:
            ops.append({"kind": "delete_relationship", "id": rng.choice(rels)})
        elif kind == "update_rel" and rels:
            ops.append(
                {
                    "kind": "update_relationship",
                    "id": rng.choice(rels),
                    "properties_patch": {"via": rng.choice(live)},
                }
            )
        elif kind == "recreate_element":
            eid = rng.choice(live)
            ops.append({"kind": "delete_element", "id": eid})
            ops.append(
                {
                    "kind": "create_element",
                    "temp_id": f"tmp_re{fresh}",
                    "id": eid,
                    "type_name": "Node",
                    "properties": {"label": "again"},
                }
            )
        elif kind == "recreate_rel" and rels:
            rid = rng.choice(rels)
            ops.append({"kind": "delete_relationship", "id": rid})
            ops.append(
                {
                    "kind": "create_relationship",
                    "temp_id": f"tmp_rr{fresh}",
                    "id": rid,
                    "type_name": "Link",
                    "source_id": rng.choice(live),
                    "target_id": rng.choice(live),
                }
            )
    return ops


def test_rows_follow_random_commits(client: TestClient) -> None:
    rng = random.Random(7)
    done = attempts = reverts = 0
    seen_422 = False
    while done < 200:
        attempts += 1
        assert attempts < 1500, "the generator no longer lands commits"
        current = head()
        rev = current.rev
        if rev > 3 and rng.random() < 0.15:
            target = rng.randint(max(0, rev - 6), rev - 1)
            r = client.post(
                papi("/commits/revert"),
                json={"target_rev": target, "base_rev": rev},
                headers=AUTH_HEADERS,
            )
            reverts += r.status_code == 200
        else:
            ids = (list(current.elements), list(current.relationships))
            r = post_commit(client, _random_ops(rng, ids))
        assert r.status_code in (200, 422), r.text
        seen_422 = seen_422 or r.status_code == 422
        done += r.status_code == 200
        # a refused batch leaves the rows as they were, so equality holds either way
        _assert_rows_equal_replay()
    assert reverts >= 5 and seen_422


def test_failed_commit_leaves_rows_unchanged(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {"label": "keep"},
            }
        ],
    )
    with _db() as s:
        before = head_mod.read_head(s, DEFAULT_PROJECT_ID)
    rev = default_state().model_rev

    def boom(*a: object, **k: object) -> None:
        raise RuntimeError("refs write failed")

    # the refs are the last thing the writer does: everything it wrote before
    # them, and the commit row, must go with the transaction
    monkeypatch.setattr(head_mod, "_replace_refs", boom)
    r = post_commit(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_b",
                "type_name": "Node",
                "properties": {"label": "lost"},
            }
        ],
    )
    assert r.status_code == 500
    monkeypatch.undo()
    assert default_state().model_rev == rev
    with _db() as s:
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == before
        assert content.get_commit(s, DEFAULT_PROJECT_ID, rev + 1) is None
    _assert_rows_equal_replay()


def test_failed_revert_leaves_rows_unchanged(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    commit_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node"}],
    )
    commit_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_b", "type_name": "Node"}],
    )
    with _db() as s:
        before = head_mod.read_head(s, DEFAULT_PROJECT_ID)
    rev = default_state().model_rev

    def boom(*a: object, **k: object) -> None:
        raise RuntimeError("refs write failed")

    monkeypatch.setattr(head_mod, "_replace_refs", boom)
    r = client.post(
        papi("/commits/revert"),
        json={"target_rev": rev - 1, "base_rev": rev},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 500
    monkeypatch.undo()
    with _db() as s:
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == before
    _assert_rows_equal_replay()


def test_nonfinite_float_arriving_by_op_is_refused(client: TestClient) -> None:
    rev = default_state().model_rev
    body = (
        '{"base_rev": %d, "ops": [{"kind": "create_element", "temp_id": "tmp_n",'
        ' "type_name": "Node", "properties": {"x": NaN}}]}' % rev
    )
    r = client.post(
        papi("/commits"),
        content=body,
        headers={**AUTH_HEADERS, "content-type": "application/json"},
    )
    assert r.status_code == 422, r.text
    assert "Non-finite" in r.text
    assert default_state().model_rev == rev
    _assert_rows_equal_replay()
    with _db() as s:
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == ([], [])


@pytest.mark.parametrize(
    "literal", ["Infinity", "-Infinity", "[1.0, NaN]", '{"a": NaN}']
)
def test_nonfinite_float_in_update_patch_is_refused(
    client: TestClient, literal: str
) -> None:
    rev = default_state().model_rev
    body = (
        '{"base_rev": %d, "ops": [{"kind": "create_element", "temp_id": "tmp_a",'
        ' "type_name": "Node", "properties": {"label": "a"}},'
        ' {"kind": "update_element", "id": "tmp_a",'
        ' "properties_patch": {"x": %s}}]}' % (rev, literal)
    )
    r = client.post(
        papi("/commits"),
        content=body,
        headers={**AUTH_HEADERS, "content-type": "application/json"},
    )
    assert r.status_code == 422, r.text
    assert default_state().model_rev == rev
    _assert_rows_equal_replay()
    with _db() as s:
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == ([], [])


@pytest.mark.parametrize("literal", ["NaN", "-Infinity", "[1.0, Infinity]"])
@pytest.mark.parametrize("final", ["create_relationship", "update_relationship"])
def test_nonfinite_float_on_a_relationship_is_refused(
    client: TestClient, literal: str, final: str
) -> None:
    rev = default_state().model_rev
    node = (
        '{"kind": "create_element", "temp_id": "tmp_%s", "type_name": "Node",'
        ' "properties": {}}'
    )
    rel = (
        '{"kind": "create_relationship", "temp_id": "tmp_r", "type_name": "Link",'
        ' "source_id": "tmp_a", "target_id": "tmp_b", "properties": %s}'
    )
    ops = [node % "a", node % "b"]
    if final == "create_relationship":
        ops.append(rel % ('{"via": %s}' % literal))
    else:
        ops.append(rel % "{}")
        ops.append(
            '{"kind": "update_relationship", "id": "tmp_r",'
            ' "properties_patch": {"via": %s}}' % literal
        )
    body = '{"base_rev": %d, "ops": [%s]}' % (rev, ", ".join(ops))
    r = client.post(
        papi("/commits"),
        content=body,
        headers={**AUTH_HEADERS, "content-type": "application/json"},
    )
    assert r.status_code == 422, r.text
    assert "Non-finite" in r.text
    assert default_state().model_rev == rev
    _assert_rows_equal_replay()
    with _db() as s:
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == ([], [])


# --- the properties text ----------------------------------------------------


def test_float_and_bigint_survive(client: TestClient) -> None:
    # the readers yield the non-finite tokens as strings; floats and integers
    # past 2**53 must come back exactly as written
    values = {"label": "NaN", "x": 1.0, "n": 2**60}
    body = commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": values,
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_b",
                "type_name": "Node",
                "properties": {"label": "-Infinity", "x": 0.5, "n": -(2**60)},
            },
        ],
    )
    with _db() as s:
        elements, _ = head_mod.read_head(s, DEFAULT_PROJECT_ID)
    by_id = {e["id"]: e for e in elements}
    got = by_id[body["id_map"]["tmp_a"]]["properties"]
    assert {k: repr(v) for k, v in got.items()} == {
        k: repr(v) for k, v in values.items()
    }
    assert repr(got["x"]) == "1.0" and repr(got["n"]) == repr(2**60)
    _assert_rows_equal_replay()


def test_installed_model_floats_survive() -> None:
    install(
        metamodel=_MM,
        model='{"elements": [{"id": "a", "type_name": "Node", "properties":'
        ' {"x": 1.0, "n": 1152921504606846976, "label": "Infinity"}, "rev": 0}],'
        ' "relationships": []}',
    )
    with _db() as s:
        (a,), _ = head_mod.read_head(s, DEFAULT_PROJECT_ID)
    assert repr(a["properties"]["x"]) == "1.0"
    assert a["properties"]["n"] == 2**60
    assert a["properties"]["label"] == "Infinity"


def test_encode_properties_is_the_line_encoders_text() -> None:
    assert head_mod.encode_properties({}) == "{}"
    assert (
        head_mod.encode_properties({"a": [1, 2.0], "b": "é", "c": None})
        == '{"a":[1,2.0],"b":"é","c":null}'
    )
    with pytest.raises(ValueError):
        head_mod.encode_properties({"x": float("nan")})


# --- refs --------------------------------------------------------------------


def test_refs_of_reads_strings_scalar_or_list() -> None:
    props = {"a": "x", "b": ["y", 3, "z", None], "c": 7, "d": None, "e": "ignored"}
    assert head_mod.refs_of(props, ("a", "b", "c", "d", "missing")) == {"x", "y", "z"}


def test_ref_props_follow_the_metamodel_and_are_cached() -> None:
    mm = load_metamodel_str(_MM)
    rp = head_mod.ref_props(mm)
    assert set(rp.element["Node"]) == {"ref", "refs"}
    assert rp.relationship["Link"] == ("via",)
    assert rp.relationship["Contains"] == ()
    assert head_mod.ref_props(mm) is rp
    assert head_mod.ref_props(load_metamodel_str(_MM)) is not rp


def test_rebind_rebuilds_refs(client: TestClient) -> None:
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "id": "a",
                "type_name": "Node",
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_b",
                "id": "b",
                "type_name": "Node",
                "properties": {"label": "a"},
            },
        ],
    )
    with _db() as s:
        assert (
            s.execute(select(func.count()).select_from(EntityRefRow)).scalar_one() == 0
        )
    rebound = _MM.replace(
        "{name: label, datatype: string}", "{name: label, datatype: Node}"
    )
    rev = default_state().model_rev
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": rev,
            "ops": [{"kind": "metamodel.rebind", "blob": rebound}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    with _db() as s:
        refs = {
            (r_, t)
            for r_, t in s.execute(
                select(EntityRefRow.referencer_id, EntityRefRow.target_id)
            )
        }
    assert refs == {("b", "a")}
    _assert_rows_equal_replay()


def test_dangling_reference_survives_target_deletion(client: TestClient) -> None:
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "id": "a",
                "type_name": "Node",
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_b",
                "id": "b",
                "type_name": "Node",
                "properties": {"ref": "a"},
            },
        ],
    )
    r = post_commit(client, [{"kind": "delete_element", "id": "a"}])
    # a dangling reference is a structural blocker; the refused batch changes nothing
    assert r.status_code == 422
    _assert_rows_equal_replay()


# --- the other writers ---------------------------------------------------------


def test_loading_a_state_leaves_written_rows_alone(client: TestClient) -> None:
    commit_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node"}],
    )
    with _db() as s:
        before = head_mod.read_head(s, DEFAULT_PROJECT_ID)
    get_registry().evict(DEFAULT_PROJECT_ID)
    get_registry().get(DEFAULT_PROJECT_ID)
    with _db() as s:
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == before


def test_rows_survive_commits_after_eviction(client: TestClient) -> None:
    commit_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node"}],
    )
    get_registry().evict(DEFAULT_PROJECT_ID)
    commit_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_b", "type_name": "Node"}],
    )
    _assert_rows_equal_replay()


def test_import_project_writes_rows_with_the_baseline() -> None:
    importer.import_project(
        project_id="p-imp",
        name="Imp",
        owner_id="o",
        metamodel_yaml=SMART_CITY_MM,
        model_json=SMART_CITY_MODEL,
    )
    with _db() as s:
        elements, relationships = head_mod.read_head(s, "p-imp")
    assert elements and relationships
    _assert_rows_equal_replay("p-imp")


def test_import_project_with_an_unbuildable_model_leaves_no_project() -> None:
    with pytest.raises(Exception):
        importer.import_project(
            project_id="p-bad",
            name="Bad",
            owner_id="o",
            metamodel_yaml=_MM,
            model_json='{"elements": [{"id": "a", "type_name": "Nope",'
            ' "properties": {}, "rev": 0}], "relationships": []}',
        )
    with _db() as s:
        assert s.get(Project, "p-bad") is None


def test_clone_copies_the_rows(client: TestClient) -> None:
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "id": "a",
                "type_name": "Node",
                "properties": {"label": "A", "n": 2**60},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_b",
                "id": "b",
                "type_name": "Node",
                "properties": {"ref": "a"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_l",
                "id": "l",
                "type_name": "Link",
                "source_id": "a",
                "target_id": "b",
                "properties": {"via": "a"},
            },
        ],
    )
    r = client.post(papi("/clone"), json={"name": "copy"}, headers=AUTH_HEADERS)
    assert r.status_code == 201, r.text
    _assert_rows_equal_replay(r.json()["id"])


def test_metamodel_upload_over_an_empty_model_resets_the_head() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    r = c.post(
        papi("/metamodel"),
        content=SMART_CITY_MM,
        headers={**AUTH_HEADERS, "content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    _assert_rows_equal_replay()
    with _db() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        assert row.next_seq == 0 and row.element_count == 0
        assert head_mod.read_head(s, DEFAULT_PROJECT_ID) == ([], [])


def test_write_batch_skips_a_project_without_a_model_row() -> None:
    mm = load_metamodel_str(_MM)
    from data_rover.api.routes.ops import _BatchResult
    from data_rover.core.model.model import Model

    seed_default_project()
    with _db() as s:
        head_mod.write_batch(s, DEFAULT_PROJECT_ID, mm, Model(mm), _BatchResult())
        assert s.execute(select(func.count()).select_from(ElementRow)).scalar_one() == 0
        assert s.execute(select(func.count()).select_from(ModelRow)).scalar_one() == 0


def test_rebuild_refs_streams_in_chunks(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ops = [
        {
            "kind": "create_element",
            "temp_id": f"tmp_{i}",
            "id": f"n{i}",
            "type_name": "Node",
            "properties": {"refs": ["n0", f"n{i}"] if i else []},
        }
        for i in range(25)
    ]
    commit_ops(client, ops)
    monkeypatch.setattr(head_mod, "REBUILD_CHUNK", 4)
    with _db() as s:
        s.query(EntityRefRow).delete()
        head_mod.rebuild_refs(s, DEFAULT_PROJECT_ID, load_metamodel_str(_MM))
        s.commit()
    _assert_rows_equal_replay()


def test_deleting_the_project_removes_its_rows(client: TestClient) -> None:
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "id": "a",
                "type_name": "Node",
                "properties": {"ref": "a"},
            }
        ],
    )
    with _db() as s:
        tenancy.delete_project(s, DEFAULT_PROJECT_ID)
        for table in (ElementRow, RelationshipRow, EntityRefRow):
            assert s.execute(select(func.count()).select_from(table)).scalar_one() == 0
