"""A metamodel rebind checked on the head rows.

The new metamodel decides what every row means, so a rebind that leaves a row
the applier does not understand is refused (422, naming the first ids) before
anything lands: an entity of a dropped or abstract type, a property that is no
longer declared, a containment second parent or cycle, a reference that points
to no element. A clean rebind lands with its refs rebuilt for the new metamodel
and its batch's model ops running as an ordinary commit under it.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from data_rover.api import content, db, rebind_check
from data_rover.api.db_models import EntityRefRow
from data_rover.api.main import create_app
from data_rover.api.project_state import DEFAULT_PROJECT_ID, get_registry
from data_rover.core.metamodel.loader import load_metamodel_str
from tests.golden.reader import load_fixture

from .conftest import AUTH_HEADERS, head, install, papi, seed_default_project

#: ``ref`` is a plain string, ``Link`` is no containment, ``Gadget`` is concrete
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
    properties:
      - {name: w, datatype: integer}
"""


def _mm(
    *,
    ref: str = "string",
    link_containment: bool = False,
    label: bool = True,
    gadget: bool = True,
    gadget_abstract: bool = False,
    link_w: bool = True,
) -> str:
    props = [f'      - {{name: ref, datatype: {ref}, multiplicity: "0..1"}}']
    if label:
        props.insert(0, "      - {name: label, datatype: string}")
    lines = ["elements:", "  - name: Node", "    properties:", *props]
    if gadget:
        lines += ["  - name: Gadget"]
        if gadget_abstract:
            lines += ["    abstract: true"]
    lines += [
        "relationships:",
        "  - name: Link",
        f"    containment: {str(link_containment).lower()}",
        "    source: Node",
        "    target: Node",
    ]
    if link_w:
        lines += ["    properties:", "      - {name: w, datatype: integer}"]
    return "\n".join(lines) + "\n"


def _element(eid: str, type_name: str = "Node", **props: Any) -> dict[str, Any]:
    return {"id": eid, "type_name": type_name, "properties": props}


def _link(rid: str, source: str, target: str, **props: Any) -> dict[str, Any]:
    return {
        "id": rid,
        "type_name": "Link",
        "source_id": source,
        "target_id": target,
        "properties": props,
    }


def _install(elements: list[dict], relationships: list[dict] | None = None) -> None:
    install(
        metamodel=_mm(),
        model=json.dumps({"elements": elements, "relationships": relationships or []}),
    )


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _rebind(client: TestClient, blob: str, *ops: dict[str, Any]) -> Response:
    lock = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert lock.status_code == 200, lock.text
    return client.post(
        papi("/commits"),
        json={
            "base_rev": head().rev,
            "ops": [{"kind": "metamodel.rebind", "blob": blob}, *ops],
            "lock_tokens": [lock.json()["token"]],
        },
    )


@contextmanager
def _s() -> Iterator[DbSession]:
    with db.db_session() as s:
        yield s


def _refs() -> set[tuple[str, str]]:
    with _s() as s:
        return {
            (r.referencer_id, r.target_id)
            for r in s.scalars(
                select(EntityRefRow).where(
                    EntityRefRow.project_id == DEFAULT_PROJECT_ID
                )
            )
        }


def _bound_metamodel_id() -> str:
    with _s() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        return row.metamodel_id


def _assert_untouched(before_refs: set[tuple[str, str]], before_mm: str) -> None:
    """A refused rebind leaves the rows, the refs, the binding and the project
    state as they were."""
    assert head().rev == 0
    assert _refs() == before_refs
    assert _bound_metamodel_id() == before_mm
    state = get_registry().get(DEFAULT_PROJECT_ID)
    assert state.metamodel is not None
    assert state.metamodel.element_type("Gadget") is not None
    assert state.model_rev == 0


# --- refusals ----------------------------------------------------------------


def test_dropping_a_type_still_in_use_is_refused_with_the_count_and_first_ids(
    client: TestClient,
) -> None:
    gadgets = [_element(f"g{i}", "Gadget") for i in range(7)]
    _install([_element("n1"), *gadgets])
    before_refs, before_mm = _refs(), _bound_metamodel_id()
    r = _rebind(client, _mm(gadget=False))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "rebind leaves 7 entities the new metamodel cannot hold: g0, g1, g2, g3, g4"
    )
    _assert_untouched(before_refs, before_mm)


def test_dropping_a_relationship_type_still_in_use_is_refused(
    client: TestClient,
) -> None:
    _install([_element("a"), _element("b")], [_link("l1", "a", "b")])
    blob = 'elements:\n  - name: Node\n    properties:\n      - {name: label, datatype: string}\n      - {name: ref, datatype: string, multiplicity: "0..1"}\n  - name: Gadget\n'
    r = _rebind(client, blob)
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "rebind leaves 1 entities the new metamodel cannot hold: l1"
    )


def test_dropping_a_property_still_set_is_refused(client: TestClient) -> None:
    _install([_element("n1", label="x"), _element("n2")])
    r = _rebind(client, _mm(label=False))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "rebind leaves 1 entities the new metamodel cannot hold: n1"
    )


def test_dropping_a_relationship_property_still_set_is_refused(
    client: TestClient,
) -> None:
    _install([_element("a"), _element("b")], [_link("l1", "a", "b", w=3)])
    r = _rebind(client, _mm(link_w=False))
    assert r.status_code == 422, r.text
    assert "cannot hold: l1" in r.json()["detail"]


def test_dropping_a_property_nobody_sets_lands(client: TestClient) -> None:
    _install([_element("n1"), _element("n2", ref="n1")])
    r = _rebind(client, _mm(label=False))
    assert r.status_code == 200, r.text


def test_making_a_used_type_abstract_is_refused(client: TestClient) -> None:
    _install([_element("g1", "Gadget"), _element("n1")])
    before_refs, before_mm = _refs(), _bound_metamodel_id()
    r = _rebind(client, _mm(gadget_abstract=True))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "rebind leaves 1 entities the new metamodel cannot hold: g1"
    )
    _assert_untouched(before_refs, before_mm)


def test_making_an_unused_type_abstract_lands(client: TestClient) -> None:
    _install([_element("n1")])
    assert _rebind(client, _mm(gadget_abstract=True)).status_code == 200


def test_a_new_containment_set_that_creates_a_second_parent_is_refused(
    client: TestClient,
) -> None:
    _install(
        [_element("p1"), _element("p2"), _element("c")],
        [_link("l1", "p1", "c"), _link("l2", "p2", "c")],
    )
    before_refs, before_mm = _refs(), _bound_metamodel_id()
    r = _rebind(client, _mm(link_containment=True))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "rebind leaves containment the new metamodel forbids (an element with two "
        "parents, or a cycle): c"
    )
    _assert_untouched(before_refs, before_mm)


def test_a_new_containment_set_that_creates_a_cycle_is_refused(
    client: TestClient,
) -> None:
    _install(
        [_element(i) for i in ("a", "b", "c", "free")],
        [_link("l1", "a", "b"), _link("l2", "b", "c"), _link("l3", "c", "a")],
    )
    before_refs, before_mm = _refs(), _bound_metamodel_id()
    r = _rebind(client, _mm(link_containment=True))
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail.startswith("rebind leaves containment")
    named = detail.rsplit(": ", 1)[1].split(", ")
    assert len(named) == 1 and named[0] in {"a", "b", "c"}
    _assert_untouched(before_refs, before_mm)


def test_a_self_loop_under_the_new_containment_set_is_a_cycle(
    client: TestClient,
) -> None:
    _install([_element("a")], [_link("l1", "a", "a")])
    r = _rebind(client, _mm(link_containment=True))
    assert r.status_code == 422, r.text
    assert r.json()["detail"].endswith(": a")


def test_a_chain_without_a_cycle_lands(client: TestClient) -> None:
    ids = [f"e{i}" for i in range(6)]
    _install(
        [_element(i) for i in ids],
        [_link(f"l{i}", ids[i], ids[i + 1]) for i in range(5)],
    )
    assert _rebind(client, _mm(link_containment=True)).status_code == 200


def test_a_property_turning_element_valued_over_a_dangling_value_is_refused(
    client: TestClient,
) -> None:
    _install([_element("a", ref="ghost"), _element("b", ref="a")])
    before_refs, before_mm = _refs(), _bound_metamodel_id()
    assert before_refs == set()  # ``ref`` is a string: no references yet
    r = _rebind(client, _mm(ref="Node"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "rebind leaves element references that point to no element, held by: a"
    )
    # the rebuilt refs went with the transaction
    _assert_untouched(before_refs, before_mm)


def test_a_property_turning_element_valued_over_a_relationship_id_is_refused(
    client: TestClient,
) -> None:
    """References are to elements: a relationship's id names none."""
    _install([_element("a", ref="l1"), _element("b")], [_link("l1", "a", "b")])
    r = _rebind(client, _mm(ref="Node"))
    assert r.status_code == 422, r.text
    assert "held by: a" in r.json()["detail"]


# --- clean rebinds -----------------------------------------------------------


def test_a_clean_rebind_lands_with_the_refs_rebuilt(client: TestClient) -> None:
    _install([_element("a", ref="b"), _element("b"), _element("c", ref="b")])
    assert _refs() == set()
    r = _rebind(client, _mm(ref="Node"))
    assert r.status_code == 200, r.text
    assert r.json()["rebound"] is True
    assert _refs() == {("a", "b"), ("c", "b")}
    assert head().rev == 1
    assert _bound_metamodel_id() == r.json()["to_metamodel_id"]


def test_a_rebind_back_to_a_string_clears_the_refs(client: TestClient) -> None:
    _install([_element("a", ref="b"), _element("b")])
    assert _rebind(client, _mm(ref="Node")).status_code == 200
    assert _refs() == {("a", "b")}
    assert _rebind(client, _mm(ref="string")).status_code == 200
    assert _refs() == set()


def test_the_rebind_batch_runs_as_a_commit_under_the_new_metamodel(
    client: TestClient,
) -> None:
    """The batch's model ops see the candidate: ``extra`` is declared only there,
    and what the batch writes as a reference is a reference in the rows."""
    _install([_element("a"), _element("b")])
    blob = _mm().replace(
        "  - name: Gadget\n",
        "  - name: Gadget\n    properties:\n      - {name: extra, datatype: string}\n",
    )
    r = _rebind(
        client,
        blob,
        {
            "kind": "create_element",
            "temp_id": "tmp_g",
            "type_name": "Gadget",
            "properties": {"extra": "hello"},
        },
    )
    assert r.status_code == 200, r.text
    gid = r.json()["id_map"]["tmp_g"]
    assert head().elements[gid]["properties"] == {"extra": "hello"}
    assert head().rev == 1


def test_the_batch_after_a_rebind_cannot_use_the_old_metamodel(
    client: TestClient,
) -> None:
    _install([_element("a")])
    r = _rebind(
        client,
        _mm(gadget=False),
        {"kind": "create_element", "temp_id": "tmp_g", "type_name": "Gadget"},
    )
    assert r.status_code == 422, r.text
    _assert_state_still_old(client)
    assert head().rev == 0 and "Gadget" not in {
        e["type_name"] for e in head().elements.values()
    }


def _assert_state_still_old(client: TestClient) -> None:
    state = get_registry().get(DEFAULT_PROJECT_ID)
    assert state.metamodel is not None
    assert state.metamodel.element_type("Gadget") is not None


def test_a_rebind_whose_batch_is_refused_leaves_the_rebuilt_refs_out(
    client: TestClient,
) -> None:
    _install([_element("a", ref="b"), _element("b")])
    r = _rebind(
        client,
        _mm(ref="Node"),
        {"kind": "create_element", "temp_id": "tmp_x", "type_name": "Nope"},
    )
    assert r.status_code == 422, r.text  # the applier's, after the swap
    assert _refs() == set()
    assert head().rev == 0
    _assert_state_still_old(client)


def test_the_state_follows_a_rebind_commit(client: TestClient) -> None:
    """The state takes the candidate metamodel and the new revision; the batch
    lands in the rows."""
    _install([_element("a")])
    blob = _mm().replace(
        "  - name: Gadget\n",
        "  - name: Gadget\n    properties:\n      - {name: extra, datatype: string}\n",
    )
    r = _rebind(
        client,
        blob,
        {"kind": "create_element", "temp_id": "tmp_g", "type_name": "Gadget"},
    )
    assert r.status_code == 200, r.text
    state = get_registry().get(DEFAULT_PROJECT_ID)
    assert state.model_rev == 1
    assert state.metamodel is not None
    assert {p.name for p in state.metamodel.effective_element_properties("Gadget")} == {
        "extra"
    }
    assert r.json()["id_map"]["tmp_g"] in head().elements


def test_a_rebind_commit_moves_a_drifted_state_to_the_rows_revision(
    client: TestClient,
) -> None:
    _install([_element("a")])
    state = get_registry().get(DEFAULT_PROJECT_ID)
    state.model_rev = 7  # not the durable 0
    r = _rebind(client, _mm(ref="Node"))
    assert r.status_code == 200, r.text
    assert head().rev == 1
    assert get_registry().get(DEFAULT_PROJECT_ID) is state
    assert state.model_rev == 1


# --- the checks themselves ---------------------------------------------------


def test_rebind_refusals_stream_in_pages(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every page is read: elements first, then relationships, in ``seq`` order."""
    monkeypatch.setattr(rebind_check, "PAGE", 3)
    _install(
        [_element(f"n{i}") for i in range(8)]
        + [
            _element("g0", "Gadget"),
            _element("n8", label="x"),
            _element("g1", "Gadget"),
        ],
        [_link(f"l{i}", "n0", "n1", w=i) for i in range(7)],
    )
    mm = load_metamodel_str(_mm(gadget=False, label=False, link_w=False))
    with _s() as s:
        count, ids = rebind_check.rebind_refusals(s, DEFAULT_PROJECT_ID, mm)
        assert count == 3 + 7  # g0, n8, g1, and the seven links that hold w
    # ... and the ids are the first ``limit``, in table then seq order
    with _s() as s:
        _, first = rebind_check.rebind_refusals(s, DEFAULT_PROJECT_ID, mm, limit=2)
        assert first == ["g0", "n8"]
    assert ids[:3] == ["g0", "n8", "g1"]


def test_rebind_refusals_of_a_conforming_project_is_empty(client: TestClient) -> None:
    _install([_element("a", label="x", ref="b"), _element("b", "Gadget")], [])
    with _s() as s:
        assert rebind_check.rebind_refusals(
            s, DEFAULT_PROJECT_ID, load_metamodel_str(_mm())
        ) == (0, [])


def test_containment_violations_without_containment_types_reads_nothing(
    client: TestClient,
) -> None:
    _install([_element("a")], [_link("l1", "a", "a")])
    with _s() as s:
        assert rebind_check.containment_violations(s, DEFAULT_PROJECT_ID, []) == []


def test_containment_violations_ignore_other_types_and_find_the_cycle(
    client: TestClient,
) -> None:
    _install(
        [_element(i) for i in ("a", "b", "c")],
        [_link("l1", "a", "b"), _link("l2", "b", "c"), _link("l3", "c", "b")],
    )
    with _s() as s:
        assert (
            rebind_check.containment_violations(s, DEFAULT_PROJECT_ID, ["Nope"]) == []
        )
        found = rebind_check.containment_violations(s, DEFAULT_PROJECT_ID, ["Link"])
    assert found and found[0] in {"b", "c"} and "a" not in found


def test_containment_violations_name_second_parents_first_and_bound_the_ids(
    client: TestClient,
) -> None:
    kids = [f"k{i}" for i in range(7)]
    _install(
        [_element("p1"), _element("p2"), *[_element(k) for k in kids]],
        [_link(f"a{k}", "p1", k) for k in kids]
        + [_link(f"b{k}", "p2", k) for k in kids],
    )
    with _s() as s:
        found = rebind_check.containment_violations(s, DEFAULT_PROJECT_ID, ["Link"])
    assert found == kids[:5]


def test_dangling_references_names_each_referencer_once(client: TestClient) -> None:
    from data_rover.api import head as head_mod

    _install(
        [_element("a", ref="x"), _element("b", ref="a")],
        [],
    )
    mm = load_metamodel_str(_mm(ref="Node"))
    with _s() as s:
        head_mod.rebuild_refs(s, DEFAULT_PROJECT_ID, mm)
        assert rebind_check.dangling_references(s, DEFAULT_PROJECT_ID) == ["a"]
        s.rollback()


# --- the engine's rebind preview is held to the same cases --------------------

_ROWS = load_fixture("rebind_rows")
_YAML = {"content-type": "application/x-yaml"}


@pytest.mark.parametrize("case", _ROWS["cases"], ids=lambda c: c["case"])
def test_the_rows_cases_the_engine_preview_is_held_to(
    client: TestClient, case: dict[str, Any]
) -> None:
    """``engine/test/service/rebind-rows.test.ts`` answers each case of the
    fixture from the replica: the same refusal text for the same rows, or no
    block. Here the server's preview and its commit answer them."""
    for blob, document in (
        (_ROWS["metamodel_yaml"], _ROWS["metamodel"]),
        (case["candidate_yaml"], case["candidate"]),
    ):
        lint = client.post(papi("/metamodel/lint"), content=blob, headers=_YAML)
        assert lint.json()["document"] == document, "the fixture's documents are served"
    install(metamodel=_ROWS["metamodel_yaml"], model=json.dumps(case["model"]))
    rebind = {"kind": "metamodel.rebind", "blob": case["candidate_yaml"]}
    preview = client.post(
        papi("/commits/preview"), json={"base_rev": head().rev, "ops": [rebind]}
    )
    commit = _rebind(client, case["candidate_yaml"])
    if case["detail"] is None:
        assert preview.status_code == 200, preview.text
        assert commit.status_code == 200, commit.text
    else:
        assert preview.status_code == 422, preview.text
        assert preview.json()["detail"] == case["detail"]
        assert commit.status_code == 422, commit.text
        assert commit.json()["detail"] == case["detail"]
