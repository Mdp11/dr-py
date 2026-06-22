"""Hydrate a cold project into a live ``Session`` and persist a live ``Session``
back to durable storage.

Hydrate = nearest snapshot (rev <= model_rev) -> ``build_model_from_dicts`` ->
replay the commit tail (rev > snapshot_rev) through the SAME restore-mode
applier the ops route uses. Persist = write the model snapshot via the
streaming serializer + record the row; a baseline reset additionally clears
old history and writes the rev-0 commit + snapshot.

A contentless project (no ``ModelRow``) hydrates to an EMPTY ``Session`` — the
exact pre-Phase-3 behaviour, so projects that haven't been given content yet
behave identically and the existing test suite stays green.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState
from data_rover.core.view.schema import View

from . import content
from .db import db_session
from .db_models import Commit
from .schemas import OPS_ADAPTER, OpIn
from .serialize import iter_model_json
from .session import Session
from .storage import get_snapshot_store, snapshot_key


def serialize_ops(ops: list[OpIn]) -> list[Any]:
    return OPS_ADAPTER.dump_python(ops, mode="json")


def deserialize_ops(raw: list[Any]) -> list[OpIn]:
    return OPS_ADAPTER.validate_python(raw)


def write_snapshot(project_id: str, session: Session, rev: int) -> None:
    """Stream the session model to the blob store and record the snapshot row."""
    assert session.model is not None
    store = get_snapshot_store()
    key = snapshot_key(project_id, rev)
    store.put(key, (chunk.encode("utf-8") for chunk in iter_model_json(session.model)))
    with db_session() as s:
        content.record_snapshot(s, project_id, rev=rev, key=key)


def persist_baseline(
    project_id: str, session: Session, *, author_id: str | None
) -> None:
    """Make the session's CURRENT model the project's durable baseline.

    Clears prior history, writes a snapshot at ``session.model_rev``, records a
    rev-0-style "baseline" commit row at that rev (empty ops — the snapshot IS
    the state), and sets ``models.model_rev`` to the session rev. The in-memory
    ``session.model_rev`` is left as-is (load-replace already bumped it), so
    snapshot rev == model_rev == DB model_rev."""
    assert session.model is not None
    rev = session.model_rev
    with db_session() as s:
        content.clear_history(s, project_id)
        content.append_commit(
            s,
            project_id,
            rev=rev,
            commit_id=uuid.uuid4().hex,
            author_id=author_id,
            ops=[],
            inverse_ops=[],
            id_map={},
        )
        content.set_model_rev(s, project_id, rev)
    write_snapshot(project_id, session, rev)


def replay_commits_into(session: Session, commits: list[Commit]) -> None:
    """Apply each commit's ops to the session model in restore mode.

    Imported here (not at module top) to avoid a circular import: ops.py
    imports nothing from hydration, hydration imports the applier from ops."""
    from .routes.ops import _apply_batch

    assert session.model is not None
    for c in commits:
        ops = deserialize_ops(c.ops)
        if ops:
            _apply_batch(session.model, ops, restore=True)


def hydrate_session(project_id: str) -> Session:
    """Build the live ``Session`` for a project from durable storage.

    No ``ModelRow`` -> empty ``Session`` (pre-Phase-3 behaviour)."""
    with db_session() as s:
        model_row = content.get_model_row(s, project_id)
        if model_row is None:
            return Session()
        mm_row = content.get_metamodel_row(s, model_row.metamodel_id)
        assert mm_row is not None  # FK guarantees it
        model_rev = model_row.model_rev
        snap = content.latest_snapshot(s, project_id, max_rev=model_rev)
        tail = (
            content.commits_after(s, project_id, snap.rev) if snap is not None else []
        )
        snap_key = snap.key if snap is not None else None
        view_row = content.get_single_view(s, project_id)
        view_blob = view_row.blob if view_row is not None else None

    metamodel = load_metamodel_str(mm_row.blob)
    if snap_key is None:
        # model row exists but no snapshot yet (shouldn't happen post-baseline);
        # treat as an empty model conforming to the metamodel.
        model = Model(metamodel)
    else:
        from .routes._snapshot import build_model_from_dicts

        raw = json.loads(get_snapshot_store().get(snap_key))
        # strict=False: hydration tolerates unknown types so a project rebound
        # onto a type-removing metamodel (Phase 6B) survives eviction; the
        # validation pipeline reports the conformance issues.
        model = build_model_from_dicts(metamodel, raw, strict=False)

    session = Session(metamodel=metamodel, model=model)
    session.model_rev = model_rev
    replay_commits_into(session, tail)
    if view_blob is not None:
        session.view = View.model_validate_json(view_blob)
    state = ValidationState()
    state.set_full(default_pipeline().validate(model, Scope.all()))
    session.validation = state
    return session
