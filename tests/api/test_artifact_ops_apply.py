"""apply_artifact_ops: full-state inverses, restore-mode exact-id
reinstatement, and the apply-then-inverse == identity property that undo
and commit diffs both lean on."""

from __future__ import annotations

from typing import cast

import pytest
from fastapi import HTTPException

from data_rover.api import content, db
from data_rover.api.artifact_ops import apply_artifact_ops, validate_artifact_ops
from data_rover.api.db_models import ArtifactKind, User
from data_rover.api.schemas import ArtifactOpIn, OPS_ADAPTER

from .conftest import seed_default_project

SNIP = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}


@pytest.fixture
def dbs():
    seed_default_project()
    with db.db_session() as s:  # db.session_scope() does not exist; db.db_session() is
        # ArtifactRow.updated_by is an FK (SQLite runs PRAGMA foreign_keys=ON,
        # see test_content.py's note on the same constraint) — every op batch
        # below passes user_id="u1", so a matching User row must exist first.
        if s.get(User, "u1") is None:
            s.add(User(id="u1", email="u1@example.com"))
            s.commit()
        yield s                 # the equivalent non-request context manager (see content.py tests)


def _ops(raw: list[dict]) -> list[ArtifactOpIn]:
    # Every batch in this module is artifact-only; OPS_ADAPTER validates
    # through the full OpIn union (it is the shared journal (de)serializer),
    # so the result is narrowed for callers typed to `list[ArtifactOpIn]`.
    return cast(list[ArtifactOpIn], OPS_ADAPTER.validate_python(raw))


def test_create_assigns_id_and_derives_metadata(dbs) -> None:
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "create_artifact", "temp_id": "tmp_s", "artifact_kind": "code_snippet",
               "name": "s1", "payload": SNIP}]),
        user_id="u1",
    )
    aid = res.id_map["tmp_s"]
    row = content.get_artifact(dbs, aid)
    assert row is not None and row.name == "s1"
    assert "value" in row.payload["entry_points"]           # server-derived
    created = res.canonical_ops[0]
    assert created.kind == "create_artifact" and created.temp_id == aid  # canonicalized
    assert res.inverse_ops()[0].kind == "delete_artifact"
    assert list(res.changed_ids) == [aid]


def test_update_inverse_carries_full_prior_state(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "update_artifact", "id": row.id, "name": "s2",
               "payload": {**SNIP, "code": "def step(el):\n    return el\n"}}]),
        user_id="u1",
    )
    inv = res.inverse_ops()[0]
    assert (
        inv.kind == "update_artifact"
        and inv.name == "s1"
        and inv.payload is not None
        and inv.payload["code"] == SNIP["code"]
    )
    # canonical op strips the consumed precondition
    updated = res.canonical_ops[0]
    assert updated.kind == "update_artifact" and updated.artifact_rev is None


def test_apply_then_inverse_restores_state(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    before = (row.name, dict(row.payload))
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "update_artifact", "id": row.id, "name": "s2",
               "payload": {**SNIP, "code": "x = 1"}},
              {"kind": "delete_artifact", "id": row.id}]),
        user_id="u1",
    )
    assert content.get_artifact(dbs, row.id) is None
    apply_artifact_ops(dbs, "default", list(res.inverse_ops()), user_id="u1", restore=True)
    restored = content.get_artifact(dbs, row.id)
    assert restored is not None                      # exact id reinstated
    assert (restored.name, dict(restored.payload))[0] == before[0]
    assert restored.payload["code"] == before[1]["code"]


def test_delete_records_header_and_recreate_inverse(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    res = apply_artifact_ops(dbs, "default",
                             _ops([{"kind": "delete_artifact", "id": row.id}]), user_id="u1")
    assert res.deleted[0]["id"] == row.id and res.deleted[0]["name"] == "s1"
    inv = res.inverse_ops()[0]
    assert inv.kind == "create_artifact" and inv.temp_id == row.id


def test_stale_rev_precondition_409(dbs) -> None:
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default",
                           _ops([{"kind": "update_artifact", "id": row.id,
                                  "artifact_rev": 99, "payload": SNIP}]), user_id="u1")
    assert e.value.status_code == 409


def test_unknown_id_and_name_clash_422(dbs) -> None:
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default",
                           _ops([{"kind": "delete_artifact", "id": "nope"}]), user_id="u1")
    assert e.value.status_code == 422
    content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                            name="taken", payload=dict(SNIP), updated_by="u1")
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default",
                           _ops([{"kind": "create_artifact", "temp_id": "tmp_x",
                                  "artifact_kind": "code_snippet", "name": "taken",
                                  "payload": SNIP}]), user_id="u1")
    assert e.value.status_code == 422


def test_validate_artifact_ops_is_write_free(dbs) -> None:
    validate_artifact_ops(dbs, "default",
                          _ops([{"kind": "create_artifact", "temp_id": "tmp_x",
                                 "artifact_kind": "code_snippet", "name": "n",
                                 "payload": SNIP}]))
    assert content.find_artifact(dbs, "default", ArtifactKind.code_snippet, "n") is None
    with pytest.raises(HTTPException):
        validate_artifact_ops(dbs, "default",
                              _ops([{"kind": "update_artifact", "id": "nope",
                                     "payload": SNIP}]))
