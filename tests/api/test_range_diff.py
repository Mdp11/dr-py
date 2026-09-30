"""The history range diff: the journal fold, the reconstruction path, and
their equality.

The fold reads each commit's captured ``entity_states``; the reconstruction
path rebuilds the model at both ends. Every history here is built through
``/model/ops`` and ``/model/undo`` (no locks, states journalled like
``POST /commits``), and the randomized test holds the two paths equal over
generated histories, values compared as canonical JSON so ``1`` and ``1.0``
stay distinct.
"""

from __future__ import annotations

import json
import random
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session as DbSession

from data_rover.api import commit_states, content, db, importer, range_diff
from data_rover.api.commit_states import EntityStates
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.range_diff import (
    RANGE_DIFF_MAX_REVS,
    can_fold,
    diff_range,
    fold_range,
    reconstruct_range,
    render_range,
)
from data_rover.api.schemas import RangeDiffOut
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, TEST_USER_ID, papi, seed_default_project
from .test_commits_metamodel_ops import _acquire_mm

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
      - name: n
        datatype: integer
      - name: x
        datatype: float
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
  - name: Link
    containment: false
    source: Node
    target: Node
    properties:
      - name: w
        datatype: integer
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    rev: int = c.get(papi("/model/summary")).json()["model_rev"]
    return rev


def _ops(c: TestClient, ops: list[dict[str, Any]]) -> dict[str, Any]:
    r = c.post(papi("/model/ops"), json={"base_rev": _rev(c), "ops": ops})
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def _undo(c: TestClient) -> dict[str, Any]:
    r = c.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def _create(eid: str, **props: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{eid}",
        "id": eid,
        "type_name": "Node",
        "properties": props,
    }


def _link(rid: str, source: str, target: str) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{rid}",
        "id": rid,
        "type_name": "Link",
        "source_id": source,
        "target_id": target,
    }


def _update(eid: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": eid, "properties_patch": patch}


@contextmanager
def _db() -> Iterator[DbSession]:
    gen = db.get_db()
    s = next(gen)
    try:
        yield s
    finally:
        gen.close()


def _fold(lo: int, hi: int) -> RangeDiffOut:
    with _db() as s:
        states = fold_range(s, DEFAULT_PROJECT_ID, lo, hi)
    return render_range(states, lo, hi, "journal")


def _recon(lo: int, hi: int) -> RangeDiffOut:
    states = reconstruct_range(DEFAULT_PROJECT_ID, lo, hi)
    return render_range(states, lo, hi, "reconstruction")


def _null_states(rev: int) -> None:
    with _db() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, rev)
        assert row is not None and row.entity_states is not None
        row.entity_states = None
        s.commit()


def _canon(out: RangeDiffOut) -> str:
    """The two halves as canonical JSON: key order fixed, ``1`` != ``1.0``."""
    dumped = out.model_dump(mode="json")
    return json.dumps(
        {"elements": dumped["elements"], "relationships": dumped["relationships"]},
        sort_keys=True,
    )


def _without_rev(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _without_rev(v) for k, v in node.items() if k != "rev"}
    if isinstance(node, list):
        return [_without_rev(v) for v in node]
    return node


def _empty(out: RangeDiffOut) -> bool:
    e, r = out.elements, out.relationships
    return not (
        e.added or e.modified or e.deleted or r.added or r.modified or r.deleted
    )


def _ids(items: list[Any]) -> list[str]:
    return [i.id for i in items]


# --- named histories ------------------------------------------------------
# Each builder returns ``(base, head)``: the rev before its first commit and
# the rev after its last. The fixture's own setup bumps the rev without
# journalling, so revs are written relative to ``base``.


def _h_update_chain(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(c, [_create("a", label="one")])  # b+1
    _ops(c, [_update("a", label="two")])  # b+2
    return b, int(_ops(c, [_update("a", label="three")])["model_rev"])  # b+3


def _h_update_back(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(c, [_create("a", label="one")])  # b+1
    _ops(c, [_update("a", label="two")])  # b+2
    return b, int(_ops(c, [_update("a", label="one")])["model_rev"])  # b+3


def _h_create_delete(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(c, [_create("a", label="one")])  # b+1
    _ops(c, [_create("b", label="two")])  # b+2
    _ops(c, [{"kind": "delete_element", "id": "b"}])  # b+3
    return b, _rev(c)


def _h_delete_undo(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(c, [_create("a", label="one")])  # b+1
    _ops(c, [{"kind": "delete_element", "id": "a"}])  # b+2
    return b, int(_undo(c)["model_rev"])  # b+3


def _h_delete_undo_update(c: TestClient) -> tuple[int, int]:
    b, _ = _h_delete_undo(c)
    return b, int(_ops(c, [_update("a", label="four")])["model_rev"])  # b+4


def _h_rewire(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(c, [_create("a"), _create("b"), _create("c")])  # b+1
    _ops(c, [_link("l", "a", "b")])  # b+2
    _ops(
        c, [{"kind": "delete_relationship", "id": "l"}, _link("l", "a", "c")]
    )  # b+3
    return b, _rev(c)


def _h_link_property(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(c, [_create("a"), _create("b")])  # b+1
    _ops(c, [_link("l", "a", "b")])  # b+2
    _ops(
        c, [{"kind": "update_relationship", "id": "l", "properties_patch": {"w": 3}}]
    )  # b+3
    return b, _rev(c)


def _h_cascade(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(
        c,
        [
            _create("p", label="p"),
            _create("q", label="q"),
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "id": "r",
                "type_name": "Contains",
                "source_id": "p",
                "target_id": "q",
            },
        ],
    )  # b+1
    _ops(c, [{"kind": "delete_element", "id": "p"}])  # b+2
    return b, _rev(c)


def _h_order(c: TestClient) -> tuple[int, int]:
    b = _rev(c)
    _ops(c, [_create("e-c"), _create("e-a")])  # b+1
    _ops(c, [_create("e-b")])  # b+2
    return b, _rev(c)


_HISTORIES: dict[str, Callable[[TestClient], tuple[int, int]]] = {
    "update_chain": _h_update_chain,
    "update_back": _h_update_back,
    "create_delete": _h_create_delete,
    "delete_undo": _h_delete_undo,
    "delete_undo_update": _h_delete_undo_update,
    "rewire": _h_rewire,
    "link_property": _h_link_property,
    "cascade": _h_cascade,
    "order": _h_order,
}


# --- fold cases -----------------------------------------------------------


def _empty_elements(out: RangeDiffOut) -> bool:
    e = out.elements
    return not (e.added or e.modified or e.deleted)


def test_created_in_range_is_added_with_the_last_state(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    assert head == b + 3
    out = _fold(b, head)
    assert out.source == "journal" and (out.from_rev, out.to_rev) == (b, head)
    assert _ids(out.elements.added) == ["a"]
    assert out.elements.added[0].properties == {"label": "three"}
    assert not out.elements.modified and not out.elements.deleted


def test_existing_before_range_is_modified_first_before_last_after(
    client: TestClient,
) -> None:
    b, head = _h_update_chain(client)
    out = _fold(b + 1, head)
    assert _ids(out.elements.modified) == ["a"]
    m = out.elements.modified[0]
    assert m.before.properties == {"label": "one"}
    assert m.after.properties == {"label": "three"}
    assert not out.elements.added and not out.elements.deleted


def test_update_then_update_back_is_empty(client: TestClient) -> None:
    b, head = _h_update_back(client)
    assert _empty(_fold(b + 1, head))
    # the two bodies differ in rev only, which the comparison ignores
    with _db() as s:
        states = fold_range(s, DEFAULT_PROJECT_ID, b + 1, head)
    before, after = states.elements["a"]
    assert before is not None and after is not None
    assert before.rev != after.rev


def test_create_and_delete_inside_range_is_empty(client: TestClient) -> None:
    b, head = _h_create_delete(client)
    assert _empty(_fold(b + 1, head))
    # b exists at neither end, so it is not even a pair
    with _db() as s:
        assert "b" not in fold_range(s, DEFAULT_PROJECT_ID, b, head).elements
    assert _ids(_fold(b, head).elements.added) == ["a"]


def test_delete_then_undo_is_never_added_and_deleted(client: TestClient) -> None:
    b, head = _h_delete_undo(client)
    assert _empty(_fold(b + 1, head))
    # the delete alone still reads as a delete, the undo alone as an add
    assert _ids(_fold(b + 1, b + 2).elements.deleted) == ["a"]
    assert _ids(_fold(b + 2, head).elements.added) == ["a"]


def test_delete_undo_then_update_is_one_modified(client: TestClient) -> None:
    b, head = _h_delete_undo_update(client)
    out = _fold(b + 1, head)
    assert _ids(out.elements.modified) == ["a"]
    assert out.elements.modified[0].before.properties == {"label": "one"}
    assert out.elements.modified[0].after.properties == {"label": "four"}
    assert not out.elements.added and not out.elements.deleted


def test_relationship_rewired_under_one_id_is_modified(client: TestClient) -> None:
    b, head = _h_rewire(client)
    out = _fold(b + 2, head)
    assert _ids(out.relationships.modified) == ["l"]
    m = out.relationships.modified[0]
    assert (m.before.source_id, m.before.target_id) == ("a", "b")
    assert (m.after.source_id, m.after.target_id) == ("a", "c")
    assert not out.relationships.added and not out.relationships.deleted
    assert _empty_elements(out)
    assert _ids(_fold(b + 1, head).relationships.added) == ["l"]


def test_relationship_property_change_is_modified(client: TestClient) -> None:
    b, head = _h_link_property(client)
    out = _fold(b + 2, head)
    assert _ids(out.relationships.modified) == ["l"]
    assert out.relationships.modified[0].after.properties == {"w": 3}


def test_element_delete_cascade_deletes_each_in_its_family(
    client: TestClient,
) -> None:
    b, head = _h_cascade(client)
    out = _fold(b + 1, head)
    assert _ids(out.elements.deleted) == ["p", "q"]
    assert _ids(out.relationships.deleted) == ["r"]
    assert not out.elements.added and not out.elements.modified
    assert not out.relationships.added and not out.relationships.modified


def test_from_equal_to_is_empty_and_reads_no_row(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    b, head = _h_update_chain(client)

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("no row may be read for an empty range")

    monkeypatch.setattr(content, "commit_states_between", boom)
    for rev in (0, b + 2, head):
        out = _fold(rev, rev)
        assert _empty(out) and (out.from_rev, out.to_rev) == (rev, rev)


def test_added_ids_answer_in_id_order(client: TestClient) -> None:
    b, head = _h_order(client)
    assert _ids(_fold(b, head).elements.added) == ["e-a", "e-b", "e-c"]
    assert _ids(_recon(b, head).elements.added) == ["e-a", "e-b", "e-c"]


def test_fold_keeps_the_first_before_and_the_last_after(client: TestClient) -> None:
    """A create in range keeps its null before past a later non-null one."""
    b = _rev(client)
    _ops(client, [_create("a", label="one")])
    _ops(client, [_update("a", label="two")])
    _ops(client, [{"kind": "delete_element", "id": "a"}])
    _undo(client)
    with _db() as s:
        states = fold_range(s, DEFAULT_PROJECT_ID, b, b + 4)
    before, after = states.elements["a"]
    assert before is None
    assert after is not None and after.properties == {"label": "two"}
    assert states.recreated_element_ids == []
    assert states.recreated_relationship_ids == []


# --- can_fold -------------------------------------------------------------


def test_can_fold_accepts_a_contiguous_range_of_states() -> None:
    marks = [(4, True, False), (5, True, False), (6, True, False)]
    assert can_fold(marks, 3, 6)
    assert can_fold([], 5, 5)


@pytest.mark.parametrize(
    "marks",
    [
        [(4, True, False), (6, True, False), (7, True, False)],  # gap
        [(4, True, False), (5, False, False), (6, True, False)],  # no states
        [(4, True, False), (5, True, True), (6, True, False)],  # rebind
        [(4, True, False), (5, True, False)],  # short
        [(4, True, False), (6, True, False), (5, True, False)],  # unordered
    ],
)
def test_can_fold_refuses_a_gap_a_stateless_row_or_a_rebind(
    marks: list[tuple[int, bool, bool]],
) -> None:
    assert not can_fold(marks, 3, 6)


def test_can_fold_caps_the_span() -> None:
    span = RANGE_DIFF_MAX_REVS
    marks = [(r, True, False) for r in range(1, span + 1)]
    assert can_fold(marks, 0, span)
    marks.append((span + 1, True, False))
    assert not can_fold(marks, 0, span + 1)


def test_range_diff_cap_value() -> None:
    assert RANGE_DIFF_MAX_REVS == 1000


def test_range_marks_read_states_and_rebind_as_scalars(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    with _db() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, b + 2)
        assert row is not None
        row.entity_states = None  # stored as JSON null
        model_row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert model_row is not None
        row.to_metamodel_id = model_row.metamodel_id
        s.commit()
        marks = content.commit_range_marks(
            s, DEFAULT_PROJECT_ID, after_rev=b, max_rev=head
        )
        assert marks == [
            (b + 1, True, False),
            (b + 2, False, True),
            (b + 3, True, False),
        ]
        assert not can_fold(marks, b, head)
        assert content.commit_range_marks(
            s, DEFAULT_PROJECT_ID, after_rev=head, max_rev=head
        ) == []


# --- the reconstruction path ---------------------------------------------


@pytest.mark.parametrize("name", sorted(_HISTORIES))
def test_reconstruction_equals_the_fold_on_every_pair(
    client: TestClient, name: str
) -> None:
    b, head = _HISTORIES[name](client)
    for lo in range(b, head + 1):
        for hi in range(lo, head + 1):
            assert _canon(_recon(lo, hi)) == _canon(_fold(lo, hi)), (name, lo, hi)


def test_reconstruction_marks_its_source(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    assert _recon(b, head).source == "reconstruction"
    assert _fold(b, head).source == "journal"


def test_reconstruction_of_a_project_without_a_model_is_empty(
    client: TestClient,
) -> None:
    states = reconstruct_range("no-such-project", 0, 0)
    assert states == EntityStates(elements={}, relationships={})


# --- diff_range -----------------------------------------------------------


def test_diff_range_folds_without_reconstructing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    b, head = _h_delete_undo_update(client)

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("reconstruct_model_at must not run on the journal path")

    monkeypatch.setattr(range_diff, "reconstruct_model_at", boom)
    with _db() as s:
        out = diff_range(s, DEFAULT_PROJECT_ID, b + 1, head)
    assert out.source == "journal"
    assert _ids(out.elements.modified) == ["a"]


def test_diff_range_reconstructs_when_a_row_lacks_states(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    folded = _fold(b, head)
    _null_states(b + 2)
    with _db() as s:
        out = diff_range(s, DEFAULT_PROJECT_ID, b, head)
    assert out.source == "reconstruction"
    assert _canon(out) == _canon(folded)


def test_diff_range_reconstructs_over_the_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    b, head = _h_update_chain(client)
    monkeypatch.setattr(range_diff, "RANGE_DIFF_MAX_REVS", 2)
    with _db() as s:
        out = diff_range(s, DEFAULT_PROJECT_ID, b, head)
    assert out.source == "reconstruction"
    assert _ids(out.elements.added) == ["a"]


def test_diff_range_reconstructs_across_a_journal_hole(client: TestClient) -> None:
    """The fixture's setup revs have no rows, so a range reaching down into
    them is not contiguous."""
    b, head = _h_update_chain(client)
    with _db() as s:
        out = diff_range(s, DEFAULT_PROJECT_ID, 0, head)
    assert out.source == "reconstruction"
    assert _ids(out.elements.added) == ["a"]


def test_diff_range_from_equal_to_is_an_empty_journal_answer(
    client: TestClient,
) -> None:
    _, head = _h_update_chain(client)
    with _db() as s:
        out = diff_range(s, DEFAULT_PROJECT_ID, head, head)
    assert out.source == "journal" and _empty(out)


# --- GET /commits/diff ----------------------------------------------------


def _get(c: TestClient, lo: int | str, hi: int | str, **kw: Any) -> Any:
    return c.get(papi("/commits/diff"), params={"from": lo, "to": hi}, **kw)


def _served(c: TestClient, lo: int, hi: int) -> RangeDiffOut:
    r = _get(c, lo, hi)
    assert r.status_code == 200, r.text
    return RangeDiffOut.model_validate(r.json())


def _expected_reconstruction(lo: int, hi: int) -> str:
    return _canon(_recon(lo, hi))


def _no_reconstruction(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("reconstruct_model_at must not run on the journal path")

    monkeypatch.setattr(range_diff, "reconstruct_model_at", boom)


def test_route_folds_a_range_from_the_journal(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    b, head = _h_delete_undo_update(client)
    _no_reconstruction(monkeypatch)
    out = _served(client, b + 1, head)
    assert out.source == "journal" and (out.from_rev, out.to_rev) == (b + 1, head)
    assert _ids(out.elements.modified) == ["a"]
    assert out.elements.modified[0].after.properties == {"label": "four"}
    assert not out.elements.added and not out.elements.deleted


def test_route_shares_the_fold_with_diff_range(client: TestClient) -> None:
    b, head = _h_rewire(client)
    assert _canon(_served(client, b + 1, head)) == _canon(_fold(b + 1, head))


@pytest.fixture
def loaded(client: TestClient) -> tuple[TestClient, int]:
    """A project whose journal starts with a baseline row (no states) at the
    rev a model load lands on; every later row is a ``/model/ops`` batch."""
    r = client.post(
        papi("/model/upload"),
        content=json.dumps({"elements": [], "relationships": []}),
    )
    assert r.status_code == 200, r.text
    base = _rev(client)
    with _db() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, base)
        assert row is not None and row.entity_states is None
    return client, base


@pytest.fixture
def imported() -> TestClient:
    """A project imported at rev 0: its baseline row holds no states and every
    later row is a ``/model/ops`` batch journalled from rev 1."""
    c = TestClient(create_app())  # installs the snapshot store the import writes to
    c.headers.update(AUTH_HEADERS)
    importer.import_project(
        project_id=DEFAULT_PROJECT_ID,
        name="Default Project",
        owner_id=TEST_USER_ID,
        metamodel_yaml=_MM,
        model_json=json.dumps({"elements": [], "relationships": []}),
    )
    assert _rev(c) == 0
    with _db() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, 0)
        assert row is not None and row.entity_states is None
    return c


def test_route_range_from_rev_zero_folds_past_a_stateless_baseline_row(
    imported: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = imported
    _ops(client, [_create("a", label="one")])
    _ops(client, [_update("a", label="two")])
    head = _rev(client)
    assert head == 2
    _no_reconstruction(monkeypatch)
    out = _served(client, 0, head)
    assert out.source == "journal"
    assert _ids(out.elements.added) == ["a"]
    assert out.elements.added[0].properties == {"label": "two"}


def test_route_range_after_a_loaded_baseline_row_folds(
    loaded: tuple[TestClient, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, base = loaded
    _ops(client, [_create("a", label="one")])
    _ops(client, [_update("a", label="two")])
    head = _rev(client)
    _no_reconstruction(monkeypatch)
    out = _served(client, base, head)
    assert out.source == "journal"
    assert _ids(out.elements.added) == ["a"]
    assert out.elements.added[0].properties == {"label": "two"}


def test_route_range_including_a_baseline_row_reconstructs(
    loaded: tuple[TestClient, int],
) -> None:
    client, base = loaded
    _ops(client, [_create("a", label="one")])
    head = _rev(client)
    with _db() as s:
        marks = content.commit_range_marks(
            s, DEFAULT_PROJECT_ID, after_rev=base - 1, max_rev=head
        )
    assert marks[0] == (base, False, False)
    out = _served(client, base - 1, head)
    assert out.source == "reconstruction"
    assert _canon(out) == _expected_reconstruction(base - 1, head)


def test_route_reconstructs_when_a_row_lacks_states(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    _null_states(b + 2)
    out = _served(client, b, head)
    assert out.source == "reconstruction"
    assert _canon(out) == _expected_reconstruction(b, head)
    assert _ids(out.elements.added) == ["a"]


def test_route_reconstructs_an_over_cap_batch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = _rev(client)
    monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)
    _ops(client, [_create("a"), _create("b")])
    head = _rev(client)
    out = _served(client, b, head)
    assert out.source == "reconstruction"
    assert _ids(out.elements.added) == ["a", "b"]
    assert _canon(out) == _expected_reconstruction(b, head)


def test_route_reconstructs_across_a_hole(client: TestClient) -> None:
    b = _rev(client)
    _ops(client, [_create("a", label="one")])
    r = client.post(papi("/model/elements"), json={"type": "Node", "properties": {}})
    assert r.status_code == 201, r.text
    _ops(client, [_create("c", label="three")])
    head = _rev(client)
    with _db() as s:
        marks = content.commit_range_marks(
            s, DEFAULT_PROJECT_ID, after_rev=b, max_rev=head
        )
    assert [m[0] for m in marks] == [b + 1, b + 3]
    assert head == b + 3
    out = _served(client, b, head)
    assert out.source == "reconstruction"
    assert _canon(out) == _expected_reconstruction(b, head)


def test_route_reconstructs_a_range_with_a_rebind(client: TestClient) -> None:
    b = _rev(client)
    _ops(client, [_create("a", label="one")])
    token = _acquire_mm(client)
    blob = _MM.replace(
        "      - name: x\n        datatype: float\n",
        "      - name: x\n        datatype: float\n"
        "      - name: owner\n        datatype: string\n",
        1,
    )
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.rebind", "blob": blob}],
            "message": "rebind",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    _ops(client, [_update("a", label="two")])
    head = _rev(client)
    with _db() as s:
        marks = content.commit_range_marks(
            s, DEFAULT_PROJECT_ID, after_rev=b, max_rev=head
        )
    assert [m[2] for m in marks] == [False, True, False]
    out = _served(client, b, head)
    assert out.source == "reconstruction"
    assert _canon(out) == _expected_reconstruction(b, head)


def test_route_reconstructs_a_range_over_the_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    b, head = _h_update_chain(client)
    monkeypatch.setattr(range_diff, "RANGE_DIFF_MAX_REVS", 2)
    out = _served(client, b, head)
    assert out.source == "reconstruction"
    assert _canon(out) == _expected_reconstruction(b, head)
    assert _served(client, b + 1, head).source == "journal"


def test_route_from_equal_to_is_an_empty_journal_answer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, head = _h_update_chain(client)
    _no_reconstruction(monkeypatch)
    for rev in (0, head):
        out = _served(client, rev, rev)
        assert out.source == "journal" and _empty(out)


@pytest.mark.parametrize("shape", ["from_gt_to", "from_negative", "to_gt_head"])
def test_route_refuses_a_range_outside_the_history(
    client: TestClient, shape: str
) -> None:
    _, head = _h_update_chain(client)
    lo, hi = {
        "from_gt_to": (head, head - 1),
        "from_negative": (-1, head),
        "to_gt_head": (0, head + 1),
    }[shape]
    r = _get(client, lo, hi)
    assert r.status_code == 422
    assert r.json() == {"detail": "rev out of range", "model_rev": head}


@pytest.mark.parametrize(
    "params",
    [{"to": 1}, {"from": 0}, {"from": "abc", "to": 1}, {"from": 0, "to": ""}, {}],
)
def test_route_refuses_malformed_params_with_fastapi_422(
    client: TestClient, params: dict[str, Any]
) -> None:
    _h_update_chain(client)
    r = client.get(papi("/commits/diff"), params=params)
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], list)


def test_route_is_not_answered_by_the_per_rev_routes(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    body = _get(client, b, head).json()
    assert body["source"] == "journal"
    assert "model_rev" not in body and "detail" not in body


def test_route_is_readable_by_a_viewer(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    with _db() as s:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    r = _get(
        client, b, head, headers={"x-user-id": "vw", "x-user-email": "vw@example.com"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "journal"


def test_route_refuses_a_non_member(client: TestClient) -> None:
    b, head = _h_update_chain(client)
    with _db() as s:
        s.add(User(id="st", email="st@example.com"))
        s.commit()
    r = _get(
        client, b, head, headers={"x-user-id": "st", "x-user-email": "st@example.com"}
    )
    assert r.status_code == 403


# --- the randomized oracle -----------------------------------------------

_LABELS = ["a", "b", "c", "d"]
_N = [1, 2**53 + 1, -7]
_X = [1.0, 0.5, 2.0]
_POOLS: dict[str, list[Any]] = {"label": _LABELS, "n": _N, "x": _X}


class _Tally:
    def __init__(self) -> None:
        self.deletes = 0
        self.undos = 0
        self.removals = 0
        self.recreates = 0


def _random_batch(
    rng: random.Random, tally: _Tally, earlier: dict[str, list[Any]]
) -> list[dict[str, Any]]:
    """One to four ops over the live model, never touching an id twice in
    conflicting ways within the batch."""
    model = get_session().model
    assert model is not None
    live_els = sorted(model.elements)
    live_rels = sorted(model.relationships)
    dead_els: set[str] = set()
    dead_rels: set[str] = set()
    ops: list[dict[str, Any]] = []
    fresh = 0

    def pick_props() -> dict[str, Any]:
        props: dict[str, Any] = {}
        for name in rng.sample(sorted(_POOLS), rng.randint(0, 3)):
            props[name] = rng.choice(_POOLS[name])
        return props

    for _ in range(rng.randint(1, 4)):
        kind = rng.choice(
            ["create", "create", "update", "update", "delete", "link", "unlink",
             "recreate"]
        )
        els = [e for e in live_els if e not in dead_els]
        rels = [
            r
            for r in live_rels
            if r not in dead_rels
            and model.relationships[r].source_id not in dead_els
            and model.relationships[r].target_id not in dead_els
        ]
        if kind == "create" or not els:
            fresh += 1
            eid = f"e{rng.randrange(10**6)}-{len(model.elements)}-{fresh}"
            ops.append(_create(eid, **pick_props()))
            live_els.append(eid)
            for name, v in ops[-1]["properties"].items():
                earlier.setdefault(f"{eid}.{name}", []).append(v)
        elif kind == "update":
            eid = rng.choice(els)
            existing = model.elements[eid].properties if eid in model.elements else {}
            patch: dict[str, Any] = {}
            for name in rng.sample(sorted(_POOLS), rng.randint(1, 3)):
                roll = rng.random()
                if roll < 0.25:
                    patch[name] = None
                    if name in existing:
                        tally.removals += 1
                elif roll < 0.5 and earlier.get(f"{eid}.{name}"):
                    patch[name] = rng.choice(earlier[f"{eid}.{name}"])
                else:
                    patch[name] = rng.choice(_POOLS[name])
                if patch[name] is not None:
                    earlier.setdefault(f"{eid}.{name}", []).append(patch[name])
            ops.append(_update(eid, **patch))
        elif kind == "delete":
            eid = rng.choice(els)
            ops.append({"kind": "delete_element", "id": eid})
            dead_els.add(eid)
            tally.deletes += 1
        elif kind == "link" and len(els) >= 1:
            fresh += 1
            rid = f"l{rng.randrange(10**6)}-{len(model.relationships)}-{fresh}"
            src, dst = rng.choice(els), rng.choice(els)
            ops.append(_link(rid, src, dst))
        elif kind == "unlink" and rels:
            rid = rng.choice(rels)
            ops.append({"kind": "delete_relationship", "id": rid})
            dead_rels.add(rid)
            tally.deletes += 1
        elif kind == "recreate" and rels:
            # a relationship deleted and created again under its id, rewired
            rid = rng.choice(rels)
            src, dst = rng.choice(els), rng.choice(els)
            ops.append({"kind": "delete_relationship", "id": rid})
            ops.append(_link(rid, src, dst))
            tally.deletes += 1
            tally.recreates += 1
            dead_rels.add(rid)
    return ops


@pytest.mark.parametrize("seed", range(20))
def test_fold_equals_reconstruction_over_random_histories(
    client: TestClient, seed: int
) -> None:
    rng = random.Random(seed)
    tally = _Tally()
    earlier: dict[str, list[Any]] = {}
    for _ in range(40):
        session = get_session()
        if rng.random() < 1 / 6 and session.op_log:
            _undo(client)
            tally.undos += 1
            continue
        ops = _random_batch(rng, tally, earlier)
        _ops(client, ops)
    head = _rev(client)
    assert tally.deletes and tally.undos and tally.removals, (seed, vars(tally))

    pairs = [(0, head), (head, head)]
    adj = rng.randrange(0, head)
    pairs.append((adj, adj + 1))
    while len(pairs) < 15:
        lo = rng.randint(0, head)
        pairs.append((lo, rng.randint(lo, head)))

    for lo, hi in pairs:
        folded = _fold(lo, hi)
        rebuilt = _recon(lo, hi)
        for out in (folded, rebuilt):
            dumped = out.model_dump(mode="json")
            for family in ("elements", "relationships"):
                for m in dumped[family]["modified"]:
                    assert _without_rev(m["before"]) != _without_rev(m["after"]), (
                        f"seed {seed} pair ({lo}, {hi}): {m['id']} modified in rev only"
                    )
        a, b = _canon(folded), _canon(rebuilt)
        if a != b:
            only_rev = _without_rev(json.loads(a)) == _without_rev(json.loads(b))
            pytest.fail(
                f"seed {seed} pair ({lo}, {hi}): fold and reconstruction differ"
                f"{' in rev only' if only_rev else ''}\nfold: {a}\nrecon: {b}"
            )
