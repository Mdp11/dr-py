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


def test_create_unsupported_kind_422(dbs) -> None:
    """`diagram`/`diagram_kind` stay unregistered in artifact_kinds.py — a
    create_artifact op naming one is a valid Literal but has no spec, and
    must 422 rather than crash later (zero prior coverage for this path)."""
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(
            dbs, "default",
            _ops([{"kind": "create_artifact", "temp_id": "tmp_d",
                   "artifact_kind": "diagram", "name": "d1", "payload": {}}]),
            user_id="u1",
        )
    assert e.value.status_code == 422


# --- Finding 1: restore mode must 422 on a DB-level name clash, not 500 ----


def test_restore_create_into_taken_name_422(dbs) -> None:
    """delete "s1" -> someone else creates a new "s1" -> undo the delete
    (a restore-mode create replaying the delete's inverse) must 422, not
    raise a raw IntegrityError, even though restore mode skips the
    pre-emptive _check_clash."""
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    original_id = row.id
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "delete_artifact", "id": original_id}]), user_id="u1",
    )
    undo_ops = list(res.inverse_ops())
    # a collaborator claims "s1" before the undo lands
    content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                            name="s1", payload=dict(SNIP), updated_by="u1")
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default", undo_ops, user_id="u1", restore=True)
    assert e.value.status_code == 422
    # the applier has NO internal rollback path (see its docstring): a DB
    # IntegrityError leaves the session's transaction needing an explicit
    # rollback before further use — exactly the contract Tasks 5/6 (the real
    # callers) fulfil via db.rollback() on any HTTPException from apply.
    dbs.rollback()


def test_restore_update_rename_into_taken_name_422(dbs) -> None:
    """rename "s1" -> "s2" -> someone else creates a new "s1" -> undo the
    rename (a restore-mode update replaying the rename's inverse, which
    renames back to "s1") must 422, not raise a raw IntegrityError."""
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    res = apply_artifact_ops(
        dbs, "default",
        _ops([{"kind": "update_artifact", "id": row.id, "name": "s2",
               "payload": dict(SNIP)}]), user_id="u1",
    )
    undo_ops = list(res.inverse_ops())
    # a collaborator claims "s1" before the undo lands
    content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                            name="s1", payload=dict(SNIP), updated_by="u1")
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(dbs, "default", undo_ops, user_id="u1", restore=True)
    assert e.value.status_code == 422
    dbs.rollback()  # see the matching comment in the create-into-taken-name test above


def test_restore_create_of_an_existing_id_reports_the_id_not_a_name(dbs) -> None:
    """A restore-mode create whose exact id is already taken (a double-undo,
    or an undo after a peer recreated the row) trips the PRIMARY KEY, not the
    name UNIQUE. Both are 422, but the message must name the real cause — the
    IntegrityError catch is scoped to the exception TYPE, so without the
    id pre-check it would blame a name clash that never happened."""
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="dup-id", payload=dict(SNIP), updated_by="u1")
    with pytest.raises(HTTPException) as e:
        apply_artifact_ops(
            dbs, "default",
            _ops([{"kind": "create_artifact", "temp_id": row.id,
                   "artifact_kind": "code_snippet", "name": "another-name",
                   "payload": dict(SNIP)}]),
            user_id="u1", restore=True,
        )
    assert e.value.status_code == 422
    assert str(e.value.detail) == f"an artifact with id {row.id!r} already exists"


# --- Finding 2: validate and apply must agree on batch-local name state ---


def test_validate_and_apply_agree_on_delete_then_reuse_name(dbs) -> None:
    """[delete X, create "X's freed name"] is a legal batch: apply succeeds
    (the name is free by the time the create runs), so validate — a preview
    of the SAME batch — must not 422 it."""
    row = content.create_artifact(dbs, "default", kind=ArtifactKind.code_snippet,
                                  name="s1", payload=dict(SNIP), updated_by="u1")
    ops = _ops([
        {"kind": "delete_artifact", "id": row.id},
        {"kind": "create_artifact", "temp_id": "tmp_x", "artifact_kind": "code_snippet",
         "name": "s1", "payload": SNIP},
    ])
    validate_artifact_ops(dbs, "default", ops)  # must not raise
    res = apply_artifact_ops(dbs, "default", ops, user_id="u1")
    assert res.canonical_ops[-1].kind == "create_artifact"


def test_validate_and_apply_agree_on_duplicate_create_in_batch(dbs) -> None:
    """[create "n", create "n"] is an illegal batch: the second create
    collides with the first's not-yet-committed claim on "n". apply already
    422s on it (the first create's row is flushed and visible to the
    second's DB lookup); validate — a preview of the SAME batch — must 422
    it too, even though it performs no writes for the first create to see."""
    ops = _ops([
        {"kind": "create_artifact", "temp_id": "tmp_a", "artifact_kind": "code_snippet",
         "name": "dup", "payload": SNIP},
        {"kind": "create_artifact", "temp_id": "tmp_b", "artifact_kind": "code_snippet",
         "name": "dup", "payload": SNIP},
    ])
    with pytest.raises(HTTPException) as e:
        validate_artifact_ops(dbs, "default", ops)
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e2:
        apply_artifact_ops(dbs, "default", ops, user_id="u1")
    assert e2.value.status_code == 422
