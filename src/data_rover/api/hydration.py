"""Hydrate a cold project into a live ``Session`` and persist a live ``Session``
back to durable storage.

Hydrate = nearest snapshot (rev <= model_rev) -> ``build_model_from_dicts`` ->
replay the commit tail (rev > snapshot_rev) through the SAME restore-mode
applier the ops route uses. Persist = stream the model through the snapshot
codec as ``datarover.snapshot/v2`` + record the row with the header's fields;
a baseline reset additionally clears old history and writes the rev-0 commit
+ snapshot.

A contentless project (no ``ModelRow``) hydrates to an EMPTY ``Session``, so
projects that haven't been given content yet behave identically and the
existing test suite stays green.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.view.ids import ensure_folder_ids
from data_rover.core.view.schema import View

from . import content
from .artifact_ops import split_ops
from .db import db_session
from .db_models import Commit
from .schemas import OPS_ADAPTER, OpIn
from .session import Session
from .snapshot_codec import decode_snapshot, encode_snapshot_v2
from .storage import get_snapshot_store, snapshot_key


def serialize_ops(ops: Sequence[OpIn]) -> list[Any]:
    # Sequence (covariant), not list: model-only callers pass a
    # `list[ModelOpIn]`, which
    # is not a `list[OpIn]` under list's invariance even though
    # ModelOpIn <: OpIn. Mixed commits pass a genuine `list[OpIn]`.
    return OPS_ADAPTER.dump_python(list(ops), mode="json")


def deserialize_ops(raw: list[Any]) -> list[OpIn]:
    return OPS_ADAPTER.validate_python(raw)


def write_snapshot(project_id: str, session: Session, rev: int) -> None:
    """Stream the session model to the blob store as a v2 text and record the
    snapshot row.

    Holds ``write_mutex`` for the whole stream: a commit landing mid-stream
    would leave a header whose counts the lines contradict, which the decoder
    refuses. The header carries the session's digest and the bound metamodel
    id (``""`` without a model row), and the row mirrors the header from the
    same values."""
    with session.write_mutex:
        model = session.model
        assert model is not None
        store = get_snapshot_store()
        key = snapshot_key(project_id, rev)
        with db_session() as s:
            model_row = content.get_model_row(s, project_id)
            metamodel_id = model_row.metamodel_id if model_row is not None else ""
            state_digest = session.state_digest()
            elements, relationships = len(model.elements), len(model.relationships)
            store.put(
                key,
                encode_snapshot_v2(
                    model,
                    project_id=project_id,
                    rev=rev,
                    metamodel_id=metamodel_id,
                    state_digest=state_digest,
                ),
            )
            content.record_snapshot(
                s,
                project_id,
                rev=rev,
                key=key,
                format="v2",
                metamodel_id=metamodel_id,
                state_digest=state_digest,
                elements=elements,
                relationships=relationships,
            )


def replay_commits_into(session: Session, commits: list[Commit]) -> None:
    """Apply each commit's ops to the session model in restore mode.

    Imported here (not at module top) to avoid a circular import: ops.py
    imports nothing from hydration, hydration imports the applier from ops."""
    from .routes.ops import _apply_batch

    assert session.model is not None
    for c in commits:
        ops, _artifact_ops, _view_ops, _metamodel_ops = split_ops(
            deserialize_ops(c.ops)
        )
        # artifact AND view ops are SKIPPED on model replay: artifact rows and
        # the view blob (ViewRow) are both materialized heads and already
        # reflect them. metamodel ops are materialized heads too
        # (ModelRow.metamodel_id / metamodel_layouts).
        if ops:
            _apply_batch(session.model, ops, restore=True)


def reconstruct_model_at(project_id: str, rev: int) -> Model | None:
    """Build the model as it existed at ``rev``.

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
        # project whose baseline snapshot was never written), replay the whole journal from rev 0 so
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

        raw = decode_snapshot(get_snapshot_store().get(snap_key))
        model = build_model_from_dicts(metamodel, raw, strict=False)

    throwaway = Session(metamodel=metamodel, model=model)
    throwaway.model_rev = rev
    replay_commits_into(throwaway, tail)
    assert throwaway.model is not None
    return throwaway.model


def hydrate_session(project_id: str) -> Session:
    """Build the live ``Session`` for a project from durable storage.

    No ``ModelRow`` -> empty ``Session``. The registry's init-once lock
    guarantees one hydration per id."""
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
        views: dict[str, View] = {}
        for view_row in content.list_views(s, project_id):
            view = View.model_validate_json(view_row.blob)
            if ensure_folder_ids(view):
                # heal-and-persist: a blob missing folder ids gets them exactly
                # once. bump_rev=False — normalization is not an edit.
                content.upsert_view(
                    s,
                    project_id,
                    view_row.id,
                    blob=view.model_dump_json(),
                    bump_rev=False,
                )
            views[view_row.id] = view

    metamodel = load_metamodel_str(mm_row.blob)
    if snap_key is None:
        # model row exists but no snapshot yet (shouldn't happen post-baseline);
        # treat as an empty model conforming to the metamodel.
        model = Model(metamodel)
    else:
        from .routes._snapshot import build_model_from_dicts

        raw = decode_snapshot(get_snapshot_store().get(snap_key))
        # strict=False: hydration tolerates unknown types so a project rebound
        # onto a type-removing metamodel survives eviction; the engine reports
        # the conformance issues.
        model = build_model_from_dicts(metamodel, raw, strict=False)

    session = Session(metamodel=metamodel, model=model)
    session.model_rev = model_rev
    replay_commits_into(session, tail)
    session.views = views
    session.strict_mode = strict_mode
    return session
