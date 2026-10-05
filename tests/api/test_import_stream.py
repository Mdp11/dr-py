"""The project import streams its model into the head rows and checks them in SQL;
a clone copies the rows in SQL. Neither builds a ``Model``.

The oracle for the rows is ``head.write_baseline`` over the model the old import
built: the streamed rows, refs, counts, digest and snapshot are identical to it.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from starlette.types import Message, Scope

from data_rover.api import content, db, head as head_mod, import_stream
from data_rover.api.db_models import (
    Commit,
    ElementRow,
    EntityRefRow,
    ModelRow,
    Project,
    RelationshipRow,
    Snapshot,
    User,
)
from data_rover.api.import_stream import _NonFiniteFilter
from data_rover.api.main import create_app
from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import parse_model_json
from data_rover.api.snapshot_codec import encode_snapshot_v2
from data_rover.api.state_digest import model_digest
from data_rover.api.storage import MemorySnapshotStore, get_snapshot_store
from data_rover.api.upload_cap import UploadCapMiddleware
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

from .conftest import (
    AUTH_HEADERS,
    SMART_CITY_MM,
    SMART_CITY_MODEL,
    TEST_USER_ID,
    commit_ops,
    head,
)

MM = """
elements:
  - name: Base
    abstract: true
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


def _node(eid: str, **props: Any) -> dict:
    return {"id": eid, "type_name": "Node", "properties": props, "rev": 0}


def _rel(rid: str, src: str, dst: str, type_name: str = "Link", **props: Any) -> dict:
    return {
        "id": rid,
        "type_name": type_name,
        "source_id": src,
        "target_id": dst,
        "properties": props,
        "rev": 0,
    }


def _doc(elements: list[dict], relationships: list[dict] | None = None) -> str:
    return json.dumps({"elements": elements, "relationships": relationships or []})


@pytest.fixture
def client() -> Iterator[TestClient]:
    """An admin (the test user), who may create projects and clone them."""
    with db.db_session() as s:
        s.add(User(id=TEST_USER_ID, email="test@example.com", is_admin=True))
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    yield c


def _create(
    c: TestClient, model: str | bytes | None, *, mm: str = MM, name: str = "P"
) -> Any:
    files = {"metamodel": ("mm.yaml", mm.encode(), "application/yaml")}
    if model is not None:
        files["model"] = (
            "m.json",
            model.encode() if isinstance(model, str) else model,
            "application/json",
        )  # type: ignore[assignment]
    return c.post("/api/v1/projects", data={"name": name}, files=files)


def _rows(project_id: str) -> dict[str, Any]:
    """Everything the head holds for a project, raw as stored."""
    with db.db_session() as s:
        row = content.get_model_row(s, project_id)
        assert row is not None
        return {
            "elements": [
                (r.id, r.type_name, r.properties, r.rev, r.seq)
                for r in s.scalars(
                    select(ElementRow)
                    .where(ElementRow.project_id == project_id)
                    .order_by(ElementRow.seq)
                )
            ],
            "relationships": [
                (
                    r.id,
                    r.type_name,
                    r.source_id,
                    r.target_id,
                    r.properties,
                    r.rev,
                    r.seq,
                )
                for r in s.scalars(
                    select(RelationshipRow)
                    .where(RelationshipRow.project_id == project_id)
                    .order_by(RelationshipRow.seq)
                )
            ],
            "refs": sorted(
                s.execute(
                    select(EntityRefRow.referencer_id, EntityRefRow.target_id).where(
                        EntityRefRow.project_id == project_id
                    )
                )
                .tuples()
                .all()
            ),
            "digest": row.state_digest,
            "counts": (row.element_count, row.relationship_count),
            "next_seq": row.next_seq,
            "rev": row.model_rev,
        }


def _baseline_rows(
    metamodel_yaml: str, model_json: str, project_id: str
) -> dict[str, Any]:
    """The rows ``write_baseline`` writes for the model the old import built."""
    mm = load_metamodel_str(metamodel_yaml)
    model = build_model_from_dicts(mm, parse_model_json(model_json))
    with db.db_session() as s:
        s.add(Project(id=project_id, name="oracle"))
        mm_row = content.create_metamodel(s, name="o", version=1, blob=metamodel_yaml)
        content.upsert_model_row(s, project_id, metamodel_id=mm_row.id)
        head_mod.write_baseline(s, project_id, mm, model)
    out = _rows(project_id)
    assert out["digest"] == model_digest(model)
    return out


def _snapshot_text(project_id: str) -> bytes:
    with db.db_session() as s:
        snap = content.get_snapshot(s, project_id, 0)
        assert snap is not None
        key = snap.key
    return gzip.decompress(get_snapshot_store().get(key))


def _oracle_snapshot(metamodel_yaml: str, model_json: str, project_id: str) -> bytes:
    mm = load_metamodel_str(metamodel_yaml)
    model = build_model_from_dicts(mm, parse_model_json(model_json))
    with db.db_session() as s:
        row = content.get_model_row(s, project_id)
        assert row is not None and row.state_digest is not None
        metamodel_id, digest = row.metamodel_id, row.state_digest
    return gzip.decompress(
        b"".join(
            encode_snapshot_v2(
                model,
                project_id=project_id,
                rev=0,
                metamodel_id=metamodel_id,
                state_digest=digest,
            )
        )
    )


# --- the rows ----------------------------------------------------------------


def test_smart_city_rows_equal_the_parsed_file_in_order(client: TestClient) -> None:
    r = _create(client, SMART_CITY_MODEL, mm=SMART_CITY_MM)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    parsed = parse_model_json(SMART_CITY_MODEL)
    with db.db_session() as s:
        elements, relationships = head_mod.read_head(s, pid)
    assert elements == [
        {
            "id": e["id"],
            "type_name": e["type_name"],
            "properties": e["properties"],
            "rev": e["rev"],
        }
        for e in parsed["elements"]
    ]
    assert relationships == [
        {
            "id": e["id"],
            "type_name": e["type_name"],
            "source_id": e["source_id"],
            "target_id": e["target_id"],
            "properties": e["properties"],
            "rev": e["rev"],
        }
        for e in parsed["relationships"]
    ]
    assert elements and relationships


def test_the_rows_are_what_write_baseline_writes(client: TestClient) -> None:
    pid = _create(client, SMART_CITY_MODEL, mm=SMART_CITY_MM).json()["id"]
    got = _rows(pid)
    want = _baseline_rows(SMART_CITY_MM, SMART_CITY_MODEL, "oracle")
    assert got == want
    assert got["refs"], "the fixture holds element references"
    assert got["next_seq"] == max(got["counts"])
    assert _snapshot_text(pid) == _oracle_snapshot(SMART_CITY_MM, SMART_CITY_MODEL, pid)


EXACT = """{
  "elements": [
    {"id": "a", "type_name": "Node", "rev": 3, "properties": {
      "x": 1.0, "n": 12345678901234567890, "label": "NaN",
      "refs": [], "nan": NaN, "inf": Infinity, "ninf": -Infinity,
      "deep": {"k": [1.0, NaN, -Infinity, {"z": Infinity}], "t": "say \\"NaN\\" Infinity"}
    }},
    {"id": "b", "type_name": "Node", "rev": 0, "properties": {"x": -0.0, "n": 9007199254740993, "e": 1E+2}}
  ],
  "relationships": [
    {"id": "r", "type_name": "Link", "source_id": "a", "target_id": "b", "rev": 1,
     "properties": {"x": 2.50, "inf": Infinity}}
  ]
}"""
EXACT_MM = MM.replace(
    '      - {name: refs, datatype: Node, multiplicity: "0..*"}\n',
    '      - {name: refs, datatype: Node, multiplicity: "0..*"}\n'
    + "".join(
        f"      - {{name: {n}, datatype: string}}\n"
        for n in ("nan", "inf", "ninf", "deep", "e")
    ),
).replace(
    "      - {name: via, datatype: Node}\n",
    "      - {name: via, datatype: Node}\n      - {name: x, datatype: float}\n      - {name: inf, datatype: string}\n",
)


def test_exact_values_survive_import_rows_and_snapshot(client: TestClient) -> None:
    r = _create(client, EXACT, mm=EXACT_MM)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    want = parse_model_json(EXACT)

    with db.db_session() as s:
        elements, relationships = head_mod.read_head(s, pid)
    assert [e["properties"] for e in elements] == [
        e["properties"] for e in want["elements"]
    ]
    assert [e["properties"] for e in relationships] == [
        e["properties"] for e in want["relationships"]
    ]
    # the same values, not merely equal ones: 1.0 stays a float, the big integer
    # stays exact, a bare literal is the string parse_model_json makes of it
    assert repr([e["properties"] for e in elements]) == repr(
        [e["properties"] for e in want["elements"]]
    )
    props = elements[0]["properties"]
    assert repr(props["x"]) == "1.0" and props["n"] == 12345678901234567890
    assert (props["nan"], props["inf"], props["ninf"]) == (
        "NaN",
        "Infinity",
        "-Infinity",
    )
    assert props["deep"]["t"] == 'say "NaN" Infinity'
    assert repr(elements[1]["properties"]["x"]) == "-0.0"
    assert elements[1]["properties"]["n"] == 9007199254740993
    assert repr(elements[1]["properties"]["e"]) == "100.0"

    got = _rows(pid)
    assert got == _baseline_rows(EXACT_MM, EXACT, "oracle")
    stored = got["elements"][0][2]
    assert '"x":1.0' in stored and '"n":12345678901234567890' in stored
    assert '"nan":"NaN"' in stored and '"ninf":"-Infinity"' in stored

    snapshot = _snapshot_text(pid)
    assert snapshot == _oracle_snapshot(EXACT_MM, EXACT, pid)
    assert b'"n":12345678901234567890' in snapshot and b'"x":1.0' in snapshot


def test_a_file_with_relationships_first_imports_the_same_rows(
    client: TestClient,
) -> None:
    elements = [_node("a"), _node("b", ref="a"), _node("c")]
    relationships = [_rel("r1", "a", "b"), _rel("r2", "b", "c", via="a")]
    first = _create(client, _doc(elements, relationships)).json()["id"]
    swapped = json.dumps(
        {"relationships": relationships, "rev": 9, "elements": elements}
    )
    second = _create(client, swapped).json()["id"]
    a, b = _rows(first), _rows(second)
    assert a == b
    assert a["counts"] == (3, 2) and a["next_seq"] == 3


def test_a_model_over_several_insert_chunks_numbers_each_table_from_zero(
    client: TestClient,
) -> None:
    n = head_mod.CHUNK * 2 + 17
    elements = [_node(f"n{i}", ref=f"n{i - 1}") if i else _node("n0") for i in range(n)]
    relationships = [_rel(f"r{i}", f"n{i}", f"n{i + 1}") for i in range(n - 1)]
    doc = _doc(elements, relationships)
    pid = _create(client, doc).json()["id"]
    got = _rows(pid)
    assert [e[4] for e in got["elements"]] == list(range(n))
    assert [r[6] for r in got["relationships"]] == list(range(n - 1))
    assert got == _baseline_rows(MM, doc, "oracle")


def test_no_model_is_an_empty_head(client: TestClient) -> None:
    pid = _create(client, None).json()["id"]
    got = _rows(pid)
    assert (
        got["counts"] == (0, 0) and got["next_seq"] == 0 and got["digest"] == "0" * 16
    )


def test_neither_import_nor_clone_builds_a_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_a: object, **_k: object) -> None:
        raise AssertionError("a model was built")

    monkeypatch.setattr(Model, "__init__", refuse)
    r = _create(client, SMART_CITY_MODEL, mm=SMART_CITY_MM)
    assert r.status_code == 201, r.text
    c = client.post(f"/api/v1/projects/{r.json()['id']}/clone", json={})
    assert c.status_code == 201, c.text


# --- the refusals --------------------------------------------------------------


def _nothing_left(name: str) -> None:
    with db.db_session() as s:
        assert (
            s.scalar(
                select(func.count()).select_from(Project).where(Project.name == name)
            )
            == 0
        )
        for table in (
            ModelRow,
            ElementRow,
            RelationshipRow,
            EntityRefRow,
            Commit,
            Snapshot,
        ):
            assert s.scalar(select(func.count()).select_from(table)) == 0, table
    store = get_snapshot_store()
    assert isinstance(store, MemorySnapshotStore) and not store._blobs


#: (id, model, check the 422 names)
CASES = [
    (
        "shared-id",
        _doc([_node("a"), _node("b")], [_rel("a", "a", "b")]),
        "id shared by an element and a relationship: a",
    ),
    (
        "missing-source",
        _doc([_node("a")], [_rel("r", "ghost", "a")]),
        "relationship end is not an element: r",
    ),
    (
        "missing-target",
        _doc([_node("a")], [_rel("r", "a", "ghost")]),
        "relationship end is not an element: r",
    ),
    (
        "dangling-at-the-last-element",
        _doc([_node("a"), _node("b", ref="a"), _node("c", refs=["a", "gone"])]),
        "dangling reference: c",
    ),
    (
        "dangling-on-a-relationship",
        _doc([_node("a")], [_rel("r", "a", "a", via="gone")]),
        "dangling reference: r",
    ),
    (
        "containment-cycle",
        _doc(
            [_node("a"), _node("b"), _node("c")],
            [
                _rel("r1", "a", "b", "Contains"),
                _rel("r2", "b", "c", "Contains"),
                _rel("r3", "c", "a", "Contains"),
            ],
        ),
        "containment cycle: ",
    ),
    (
        "two-containment-parents",
        _doc(
            [_node("a"), _node("b"), _node("c")],
            [_rel("r1", "a", "c", "Contains"), _rel("r2", "b", "c", "Contains")],
        ),
        "element with two containment parents: c",
    ),
    (
        "unknown-element-type",
        _doc(
            [_node("a"), {"id": "b", "type_name": "Nope", "properties": {}, "rev": 0}]
        ),
        "unknown element type: 1 entity, first b",
    ),
    (
        "unknown-relationship-type",
        _doc([_node("a")], [_rel("r", "a", "a", "Nope")]),
        "unknown relationship type: 1 entity, first r",
    ),
    (
        "abstract-type",
        _doc([{"id": "b", "type_name": "Base", "properties": {}, "rev": 0}]),
        "abstract element type: 1 entity, first b",
    ),
    (
        "undeclared-property",
        _doc([_node("a", label="x", colour="red")]),
        "undeclared property: 1 entity, first a",
    ),
    (
        "undeclared-relationship-property",
        _doc([_node("a")], [_rel("r", "a", "a", colour="red")]),
        "undeclared property: 1 entity, first r",
    ),
    (
        "duplicate-element-id",
        _doc([_node("a"), _node("b"), _node("a")]),
        "duplicate element id: 1 entity, first a",
    ),
    (
        "duplicate-relationship-id",
        _doc([_node("a")], [_rel("r", "a", "a"), _rel("r", "a", "a")]),
        "duplicate relationship id: 1 entity, first r",
    ),
    (
        "reserved-id",
        _doc([_node("tmp_a")]),
        "reserved id: 1 entity, first tmp_a",
    ),
    (
        "shapeless-entity",
        '{"elements": [{"id": "a", "type_name": "Node", "rev": "0"}], "relationships": []}',
        "invalid entity: 1 entity, first a",
    ),
    (
        "float-rev",
        '{"elements": [{"id": "a", "type_name": "Node", "rev": 1.0}], "relationships": []}',
        "invalid entity: 1 entity, first a",
    ),
    (
        "negative-number-past-the-double-range",
        '{"elements": [{"id": "a", "type_name": "Node", "properties": {"x": -1e999}}]}',
        "non-finite number: 1 entity, first a",
    ),
    (
        "number-past-the-double-range",
        '{"elements": [{"id": "a", "type_name": "Node", "properties": {"x": 1e999}}]}',
        "invalid JSON",
    ),
    ("elements-not-a-list", '{"elements": {"a": 1}}', "must be a list"),
    ("elements-null", '{"elements": null}', "must be a list"),
    (
        "repeated-elements-key",
        '{"elements": [], "elements": []}',
        "repeats field 'elements'",
    ),
    ("not-an-object", "[1, 2]", "must be a JSON object"),
    ("truncated", '{"elements": [{"id": "a"', "invalid JSON"),
    ("empty", "", "invalid JSON"),
    ("trailing-data", '{"elements": []} {}', "invalid JSON"),
    (
        "literal-as-a-key",
        '{"elements": [{"id": "a", "type_name": "Node", "properties": {NaN: 1}}]}',
        "invalid JSON",
    ),
    (
        "bare-garbage",
        '{"elements": [{"id": "a", "type_name": "Node", "properties": {"x": Infinit}}]}',
        "invalid JSON",
    ),
]


@pytest.mark.parametrize(
    ("model", "detail"), [c[1:] for c in CASES], ids=[c[0] for c in CASES]
)
def test_each_refusal_is_a_422_naming_its_check_and_leaves_nothing(
    client: TestClient, model: str, detail: str
) -> None:
    r = _create(client, model, name="Refused")
    assert r.status_code == 422, r.text
    assert detail in r.json()["detail"], r.json()["detail"]
    _nothing_left("Refused")


def test_a_failure_on_the_very_last_check_rolls_back_rows_already_written(
    client: TestClient,
) -> None:
    # several insert chunks are in the transaction when the last element's
    # reference turns out to dangle
    n = head_mod.CHUNK * 3
    elements = [_node(f"n{i}") for i in range(n)] + [_node("last", ref="gone")]
    relationships = [
        _rel(f"r{i}", f"n{i}", f"n{i + 1}", "Contains") for i in range(n - 1)
    ]
    r = _create(client, _doc(elements, relationships), name="Late")
    assert r.status_code == 422 and "dangling reference: last" in r.json()["detail"]
    _nothing_left("Late")
    # the next import is unaffected
    assert _create(client, _doc([_node("a")]), name="Late").status_code == 201


def test_refusals_count_past_the_first_five_ids(client: TestClient) -> None:
    elements = [
        {"id": f"u{i}", "type_name": "Nope", "properties": {}, "rev": 0}
        for i in range(12)
    ]
    r = _create(client, _doc(elements), name="Many")
    assert r.status_code == 422
    assert (
        r.json()["detail"]
        == "unknown element type: 12 entities, first u0, u1, u2, u3, u4"
    )
    _nothing_left("Many")


def test_each_kind_of_refusal_is_reported_together(client: TestClient) -> None:
    elements = [
        {"id": "u", "type_name": "Nope", "properties": {}, "rev": 0},
        {"id": "b", "type_name": "Base", "properties": {}, "rev": 0},
    ]
    detail = _create(client, _doc(elements), name="Both").json()["detail"]
    assert "unknown element type" in detail and "abstract element type" in detail


def test_a_bad_metamodel_or_view_or_bundle_is_a_422_and_leaves_nothing(
    client: TestClient,
) -> None:
    assert _create(client, _doc([]), mm="not: [valid", name="BadMm").status_code == 422
    _nothing_left("BadMm")
    r = client.post(
        "/api/v1/projects",
        data={"name": "BadView"},
        files={
            "metamodel": ("mm.yaml", MM.encode(), "application/yaml"),
            "view": ("v.json", b"{not json", "application/json"),
        },
    )
    assert r.status_code == 422 and "invalid view" in r.json()["detail"]
    _nothing_left("BadView")
    r = client.post(
        "/api/v1/projects",
        data={"name": "BadBundle"},
        files={
            "metamodel": ("mm.yaml", MM.encode(), "application/yaml"),
            "artifacts": ("b.json", b"{not json", "application/json"),
        },
    )
    assert r.status_code == 422 and "invalid artifact bundle" in r.json()["detail"]
    _nothing_left("BadBundle")


# --- the upload cap --------------------------------------------------------------


def test_a_declared_600_mib_body_is_413_before_anything_is_read(
    client: TestClient,
) -> None:
    r = client.post(
        "/api/v1/projects",
        content=b"x",
        headers={
            "content-length": str(600 * 1024 * 1024),
            "content-type": "multipart/form-data; boundary=b",
        },
    )
    assert r.status_code == 413
    assert "too large" in r.json()["detail"]


def test_a_body_over_the_cap_is_413_and_one_under_it_is_taken(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = _doc([_node(f"n{i}") for i in range(200)])
    monkeypatch.setenv("DATA_ROVER_MAX_REQUEST_BODY_BYTES", str(len(model) - 1))
    r = _create(client, model, name="Capped")
    assert r.status_code == 413
    _nothing_left("Capped")
    monkeypatch.setenv("DATA_ROVER_MAX_REQUEST_BODY_BYTES", str(len(model) + 2000))
    assert _create(client, model, name="Capped").status_code == 201
    monkeypatch.setenv("DATA_ROVER_MAX_REQUEST_BODY_BYTES", "0")  # disabled
    assert _create(client, model, name="Uncapped").status_code == 201


def _run_through_cap(
    limit: int,
    chunks: list[bytes],
    *,
    headers: list[tuple[bytes, bytes]] | None = None,
    monkeypatch: pytest.MonkeyPatch,
    path: str = "/api/v1/projects",
) -> tuple[list[int], int | None]:
    """What an app behind the middleware reads of a body sent in ``chunks``,
    and the status it answered (None when the app itself answered)."""
    monkeypatch.setenv("DATA_ROVER_MAX_REQUEST_BODY_BYTES", str(limit))
    read: list[int] = []

    async def app(scope: Scope, receive: Any, send: Any) -> None:
        more = True
        while more:
            message = await receive()
            read.append(len(message["body"]))
            more = message.get("more_body", False)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    messages: list[Message] = [
        {"type": "http.request", "body": c, "more_body": i < len(chunks) - 1}
        for i, c in enumerate(chunks)
    ]
    sent: list[Message] = []

    async def receive() -> Message:
        return messages.pop(0)

    async def send(message: Message) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": path, "headers": headers or []}
    wrapped = UploadCapMiddleware(app, path="/api/v1/projects")

    async def go() -> None:
        try:
            await wrapped(scope, receive, send)  # type: ignore[arg-type]
        except Exception as exc:
            sent.append({"type": "raised", "status": getattr(exc, "status_code", None)})  # type: ignore[typeddict-unknown-key]

    asyncio.run(go())
    status = next(
        (
            m.get("status")
            for m in sent
            if m["type"] in ("http.response.start", "raised")
        ),
        None,
    )
    return read, status


def test_the_cap_counts_a_streamed_body_with_no_content_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chunks = [b"x" * 400] * 5
    read, status = _run_through_cap(1000, chunks, monkeypatch=monkeypatch)
    assert status == 413 and read == [400, 400]  # refused on the chunk that crossed it
    read, status = _run_through_cap(2000, chunks, monkeypatch=monkeypatch)
    assert status == 200 and read == [400] * 5


def test_the_cap_ignores_other_paths_and_methods(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    read, status = _run_through_cap(
        10, [b"x" * 400], monkeypatch=monkeypatch, path="/api/v1/other"
    )
    assert status == 200 and read == [400]


# --- the filter, in isolation -----------------------------------------------------

FILTER_CASES = [
    (b'{"a":[NaN,Infinity,-Infinity]}', b'{"a":["NaN","Infinity","-Infinity"]}'),
    (
        b'{"a":"NaN Infinity -Infinity","b":NaN}',
        b'{"a":"NaN Infinity -Infinity","b":"NaN"}',
    ),
    (b'{"a":"\\"NaN\\"","b":NaN}', b'{"a":"\\"NaN\\"","b":"NaN"}'),
    (b'{"a":"\\\\","b":NaN}', b'{"a":"\\\\","b":"NaN"}'),
    (b'{"a" : NaN , "b":[ -Infinity ]}', b'{"a" : "NaN" , "b":[ "-Infinity" ]}'),
    (b"{NaN: 1}", b"{NaN: 1}"),
    (b'{"a":1,"b":-5,"c":1e-5,"d":[-1]}', b'{"a":1,"b":-5,"c":1e-5,"d":[-1]}'),
    (b'["\xc3\xa9NaN\xc3\xa9", NaN]', b'["\xc3\xa9NaN\xc3\xa9", "NaN"]'),
    (b"[NaN", b'["NaN"'),
    (b'["NaN', b'["NaN'),
    (b"[Infin", b"[Infin"),
    (b"[-", b"[-"),
]


@pytest.mark.parametrize(("text", "want"), FILTER_CASES)
@pytest.mark.parametrize("size", [1, 2, 3, 5, 8, 64 * 1024])
def test_the_filter_rewrites_literals_wherever_the_reads_fall(
    text: bytes, want: bytes, size: int
) -> None:
    f = _NonFiniteFilter(io.BytesIO(text))
    parts = []
    while chunk := f.read(size):
        parts.append(chunk)
    assert b"".join(parts) == want


def test_the_filter_probe_read_of_zero_consumes_nothing() -> None:
    f = _NonFiniteFilter(io.BytesIO(b"[NaN]"))
    assert f.read(0) == b""
    assert f.read(100) == b'["NaN"]'


def test_a_long_string_is_scanned_once_whatever_it_holds() -> None:
    text = b'["' + (b'NaN \\" Infinity \\\\' * 50_000) + b'", NaN]'
    f = _NonFiniteFilter(io.BytesIO(text))
    out = b"".join(iter(lambda: f.read(4096), b""))
    assert out == text[:-4] + b'"NaN"]'


# --- the parser agrees with parse_model_json ----------------------------------------

AGREE = [
    '{"a": 1.0}',
    '{"a": -0.0, "b": -0, "c": 1E+2, "d": 0.1, "e": 1e-7}',
    '{"a": 12345678901234567890, "b": 2.5e3, "c": 123456789012345678901234567890}',
    '{"a": NaN, "b": [Infinity, -Infinity], "c": {"d": NaN}}',
    '{"a": "\\u00e9\\ud83d\\ude00 \\u0000 \\/ \\n", "b": "  \x7f"}',
    '{"a": 1, "a": 2}',
    '{"a": [[], {}, null, true, false, [[1.0]]]}',
]


@pytest.mark.parametrize("text", AGREE)
def test_the_stream_parser_reads_what_parse_model_json_reads(text: str) -> None:
    doc = f'{{"elements": [{{"id": "a", "properties": {text}}}]}}'
    ((_section, _index, got),) = import_stream._entities(io.BytesIO(doc.encode()))
    want = parse_model_json(doc)["elements"][0]
    assert repr(got) == repr(want)


# --- clone -------------------------------------------------------------------------


def test_the_clone_has_the_sources_rows_digest_and_counts(client: TestClient) -> None:
    src = _create(client, SMART_CITY_MODEL, mm=SMART_CITY_MM, name="Src").json()["id"]
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_n",
                "id": "x1",
                "type_name": "Organization",
                "properties": {"name": "Added"},
            }
        ],
        project_id=src,
    )
    # the commit changed the head: the clone copies THIS state, not the import's
    r = client.post(f"/api/v1/projects/{src}/clone", json={"name": "Dup"})
    assert r.status_code == 201, r.text
    new = r.json()["id"]
    assert r.json()["name"] == "Dup" and r.json()["role"] == "owner"

    a, b = _rows(src), _rows(new)
    assert (a["rev"], b["rev"]) == (1, 0)
    assert b["elements"] == a["elements"] and b["relationships"] == a["relationships"]
    assert b["refs"] == a["refs"] and b["refs"]
    assert (
        b["digest"] == a["digest"]
        and b["counts"] == a["counts"]
        and b["next_seq"] == a["next_seq"]
    )
    assert ("x1" in {e[0] for e in b["elements"]}) and head(new).rev == 0
    # a rev-0 baseline: one import commit, a snapshot at rev 0 equal to the rows
    with db.db_session() as s:
        assert [
            c.rev for c in s.scalars(select(Commit).where(Commit.project_id == new))
        ] == [0]
        assert (
            s.scalar(
                select(func.count())
                .select_from(Snapshot)
                .where(Snapshot.project_id == new)
            )
            == 1
        )
    snapshot = _snapshot_text(new)
    assert (
        snapshot.count(b"\n") == a["counts"][0] + a["counts"][1] + 1
    )  # header + a line each
    assert b'"id":"x1"' in snapshot


def test_a_commit_on_the_clone_leaves_the_source_unchanged(client: TestClient) -> None:
    src = _create(client, SMART_CITY_MODEL, mm=SMART_CITY_MM, name="Src").json()["id"]
    new = client.post(f"/api/v1/projects/{src}/clone", json={}).json()["id"]
    before = _rows(src)
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_n",
                "type_name": "Organization",
                "properties": {"name": "Only in the clone"},
            }
        ],
        project_id=new,
    )
    assert _rows(src) == before
    after = _rows(new)
    assert (
        after["counts"][0] == before["counts"][0] + 1
        and after["digest"] != before["digest"]
    )
    assert head(src).rev == 0 and head(new).rev == 1


def test_a_clone_of_exact_values_keeps_them(client: TestClient) -> None:
    src = _create(client, EXACT, mm=EXACT_MM, name="Src").json()["id"]
    new = client.post(f"/api/v1/projects/{src}/clone", json={}).json()["id"]
    assert _rows(new) == _rows(src)
    assert (
        _snapshot_text(new).split(b"\n", 1)[1] == _snapshot_text(src).split(b"\n", 1)[1]
    )


def test_a_clone_of_a_project_without_head_rows_is_a_409(client: TestClient) -> None:
    src = _create(client, _doc([_node("a")]), name="Src").json()["id"]
    with db.db_session() as s:
        row = content.get_model_row(s, src)
        assert row is not None
        row.next_seq = None
    r = client.post(f"/api/v1/projects/{src}/clone", json={})
    assert r.status_code == 409 and "head rows" in r.json()["detail"]
    with db.db_session() as s:
        assert s.scalar(select(func.count()).select_from(Project)) == 1


def test_a_clone_lands_views_and_artifacts_under_fresh_ids(client: TestClient) -> None:
    src = _create(client, _doc([_node("a")]), name="Src").json()["id"]
    r = client.post(
        f"/api/v1/projects/{src}/views",
        json={"name": "V", "view": {"name": "V", "folders": [], "elements": ["a"]}},
    )
    assert r.status_code == 201, r.text
    new = client.post(f"/api/v1/projects/{src}/clone", json={}).json()["id"]
    with db.db_session() as s:
        views = content.list_views(s, new)
        assert [v.name for v in views] == ["V"]
        assert views[0].id not in {v.id for v in content.list_views(s, src)}
