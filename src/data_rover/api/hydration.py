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
from dataclasses import dataclass
from typing import Any

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.state import ValidationState
from data_rover.core.view.schema import View

from . import content
from .db import db_session
from .db_models import Commit
from .schemas import OPS_ADAPTER, OpIn
from .serialize import iter_model_json
from .session import Session
from .storage import get_snapshot_store, snapshot_key
from .validation_sweep import start_validation_sweep


@dataclass
class HydrationProgress:
    """Live progress of one in-flight hydration, keyed by project id.

    Registered for exactly the duration of ``hydrate_session`` so the status
    endpoint can report an open that has not produced a Session yet. ``total``
    is 0 until the build phase knows its entity count (indeterminate)."""

    phase: str = "download"  # download | parse | build | replay
    done: int = 0
    total: int = 0


#: project id -> in-flight hydration progress (single mutating writer — the
#: hydrating thread under the registry's per-project init-once lock; readers
#: are GET /model/status requests, which only read primitive fields)
_hydration_progress: dict[str, HydrationProgress] = {}


def hydration_progress(project_id: str) -> HydrationProgress | None:
    return _hydration_progress.get(project_id)


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


def reconstruct_model_at(project_id: str, rev: int) -> Model | None:
    """Build the model as it existed at ``rev`` (Phase 8 history diffs).

    Mirrors ``hydrate_session`` but bounded to ``rev`` and returning a
    THROWAWAY core ``Model`` — it never touches the registry session or any
    snapshot writes. The base snapshot is built ``strict=False`` under the
    metamodel effective at ``rev`` (see ``first_rebind_after``), so a snapshot
    from a different metamodel era across a rebind still loads; ``computeDiff``
    on the client is purely structural, so the diff stays well-defined.

    Returns ``None`` for a contentless project (no ``ModelRow``).
    """
    with db_session() as s:
        model_row = content.get_model_row(s, project_id)
        if model_row is None:
            return None
        # metamodel effective AT rev: the from-side of the first rebind after
        # rev, else the current binding.
        rebind = content.first_rebind_after(s, project_id, rev)
        mm_id = (
            rebind.from_metamodel_id
            if rebind is not None and rebind.from_metamodel_id is not None
            else model_row.metamodel_id
        )
        mm_row = content.get_metamodel_row(s, mm_id)
        assert mm_row is not None
        snap = content.latest_snapshot(s, project_id, max_rev=rev)
        # With a snapshot, replay only the tail above it; with none (e.g. a
        # project built purely via the unlocked /model/ops path, which writes
        # no eager baseline snapshot), replay the whole journal from rev 0 so
        # the reconstructed state is complete. (hydrate_session uses ``else []``
        # because a missing snapshot is an anomaly there; here it is normal.)
        tail = content.commits_between(
            s,
            project_id,
            after_rev=snap.rev if snap is not None else 0,
            max_rev=rev,
        )
        snap_key = snap.key if snap is not None else None

    metamodel = load_metamodel_str(mm_row.blob)
    if snap_key is None:
        model = Model(metamodel)
    else:
        from .routes._snapshot import build_model_from_dicts

        raw = json.loads(get_snapshot_store().get(snap_key))
        model = build_model_from_dicts(metamodel, raw, strict=False)

    throwaway = Session(metamodel=metamodel, model=model)
    throwaway.model_rev = rev
    replay_commits_into(throwaway, tail)
    assert throwaway.model is not None
    return throwaway.model


def hydrate_session(project_id: str) -> Session:
    """Build the live ``Session`` for a project from durable storage.

    No ``ModelRow`` -> empty ``Session`` (pre-Phase-3 behaviour). Progress is
    published in ``_hydration_progress`` for GET /model/status while this
    runs (the registry's init-once lock guarantees one hydration per id)."""
    progress = HydrationProgress()
    _hydration_progress[project_id] = progress
    try:
        return _hydrate_session(project_id, progress)
    finally:
        _hydration_progress.pop(project_id, None)


def _hydrate_session(project_id: str, progress: HydrationProgress) -> Session:
    with db_session() as s:
        model_row = content.get_model_row(s, project_id)
        if model_row is None:
            return Session()
        mm_row = content.get_metamodel_row(s, model_row.metamodel_id)
        assert mm_row is not None  # FK guarantees it
        model_rev = model_row.model_rev
        strict_mode = bool((model_row.validation_policy or {}).get("strict", False))
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

        progress.phase = "download"
        blob = get_snapshot_store().get(snap_key)
        progress.phase = "parse"
        raw = json.loads(blob)
        progress.phase = "build"

        def _on_build(done: int, total: int) -> None:
            progress.done, progress.total = done, total

        # strict=False: hydration tolerates unknown types so a project rebound
        # onto a type-removing metamodel (Phase 6B) survives eviction; the
        # validation pipeline reports the conformance issues.
        model = build_model_from_dicts(metamodel, raw, strict=False, on_progress=_on_build)

    session = Session(metamodel=metamodel, model=model)
    session.model_rev = model_rev
    progress.phase = "replay"
    replay_commits_into(session, tail)
    if view_blob is not None:
        session.view = View.model_validate_json(view_blob)
    session.validation = ValidationState()
    session.strict_mode = strict_mode
    start_validation_sweep(session)
    return session
