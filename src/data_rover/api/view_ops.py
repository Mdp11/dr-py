"""View-op plumbing (Phase 2 artefacts revamp).

The view is a materialized head (``session.view`` in memory, ``ViewRow.blob``
durable), so view ops must never reach the model applier. This module is the
in-memory twin of ``artifact_ops``: ``apply_view_ops`` mutates a core ``View``
in place while collecting EXACT inverses — apply-then-inverse restores a
byte-identical blob, the invariant ``POST /model/undo`` and the commit-diff
API lean on. ``routes/commits.py`` is the write caller (apply under the write
mutex, persist the blob on the commit's DB transaction); ``routes/ops.py``'s
undo replays inverses in restore mode; ``/commits/preview`` validates dry.

Unlike the artifact applier there is no DB here at all: rollback is
``rollback_view`` (apply the collected inverse units in reverse), the same
in-place shape as ``routes/ops.py::_rollback``.

Tolerance stance (mirrors ``validate_view``): ids that merely DANGLE (an
element not in the model, an artifact with no row) are legal — the view never
owns what it references. 422 is reserved for ops that are IMPOSSIBLE against
the current tree: unknown folder ids, cycle moves, duplicate/missing
placements. Restore mode (undo) skips the duplicate-PLACEMENT checks —
replaying accepted history over a peer-modified view degrades to a
first-placement-wins warning, never a failed undo — but still 422s on a
missing folder (the compensating commit must not silently half-apply).
The asymmetry is one-sided, though: restore mode does NOT skip the
missing-PLACEMENT checks on ``remove_element``/``remove_artifact``/
``move_artifact`` — replaying one of those inverses against a view where a
peer already removed the placement it expects to find still 422s, same as a
non-restore call. Only the "already placed" family degrades to tolerance;
the "not placed" family does not.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import assert_never

from fastapi import HTTPException

from data_rover.core.view.ids import find_folder, folder_subtree, locate_folder
from data_rover.core.view.schema import VIEW_ROOT_ID, ArtifactRef, Folder, View

from .locking import folder_resource
from .schemas import (
    TEMP_ID_PREFIX,
    CreateFolderOp,
    DeleteFolderOp,
    MoveArtifactOp,
    MoveElementOp,
    MoveFolderOp,
    PlaceArtifactOp,
    PlaceElementOp,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
    ViewOpIn,
)


@dataclass
class ViewBatchResult:
    """Everything one view-op batch produced (twin of ArtifactBatchResult).

    ``inverse_units`` are per-op lists because delete_folder's inverse is a
    multi-op recreate of the whole subtree; every other op inverts 1:1."""

    canonical_ops: list[ViewOpIn] = field(default_factory=list)
    inverse_units: list[list[ViewOpIn]] = field(default_factory=list)
    id_map: dict[str, str] = field(default_factory=dict)

    def inverse_ops(self) -> list[ViewOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def _422(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _require_folder(view: View, folder_id: str) -> Folder:
    f = find_folder(view, folder_id)
    if f is None:
        raise _422(f"unknown folder {folder_id!r}")
    return f


def _container(view: View, container_id: str) -> View | Folder:
    """The node whose ``.folders``/``.artifacts`` list *container_id* names.
    Elements may not be placed at the root, but artifacts have a REAL root
    list (``View.artifacts``) — hence root resolves to the View itself."""
    if container_id == VIEW_ROOT_ID:
        return view
    return _require_folder(view, container_id)


def _container_id(node: View | Folder) -> str:
    return VIEW_ROOT_ID if isinstance(node, View) else node.id


def _clamped(index: int | None, length: int) -> int:
    if index is None:
        return length
    return max(0, min(index, length))


def _subtree_ids(folder: Folder) -> set[str]:
    """*folder*'s id + all descendant folder ids (the move-cycle check)."""
    out: set[str] = set()
    stack = [folder]
    while stack:
        f = stack.pop()
        out.add(f.id)
        stack.extend(f.folders)
    return out


def _element_home(view: View, element_id: str) -> Folder | None:
    """The folder holding *element_id*'s placement, if any (single-folder
    rule: an element sits in at most one folder)."""
    stack = list(view.folders)
    while stack:
        f = stack.pop()
        if element_id in f.elements:
            return f
        stack.extend(f.folders)
    return None


def _recreate_ops(folder: Folder, parent_id: str, index: int) -> list[ViewOpIn]:
    """Ops that rebuild *folder* (and its whole subtree) exactly, in an order
    replayable front-to-back: the folder first, then its own placements at
    exact indices, then children recursively. ``temp_id`` carries the REAL id
    — in restore mode the applier reinstates it verbatim."""
    ops: list[ViewOpIn] = [
        CreateFolderOp(
            kind="create_folder",
            temp_id=folder.id,
            parent_id=parent_id,
            name=folder.name,
            index=index,
        )
    ]
    for i, element_id in enumerate(folder.elements):
        ops.append(
            PlaceElementOp(
                kind="place_element",
                element_id=element_id,
                folder_id=folder.id,
                index=i,
            )
        )
    for i, ref in enumerate(folder.artifacts):
        ops.append(
            PlaceArtifactOp(
                kind="place_artifact",
                artifact_id=ref.id,
                artifact_kind=ref.kind,
                folder_id=folder.id,
                index=i,
            )
        )
    for i, child in enumerate(folder.folders):
        ops.extend(_recreate_ops(child, folder.id, i))
    return ops


def apply_view_ops(
    view: View,
    ops: list[ViewOpIn],
    *,
    id_map: dict[str, str] | None = None,
    restore: bool = False,
) -> ViewBatchResult:
    """Apply view ops to *view* in place, collecting exact inverses.

    ``id_map`` is seeded with the model/artifact halves' temp→canonical map so
    a placement may reference an element or artifact created earlier in the
    SAME batch; folder temp ids created here are added to the same map.
    Canonical ops always carry resolved ids and CONCRETE indices — the journal
    must replay deterministically with no reference to live state.

    There is NO internal rollback, and on a mid-batch failure the raised
    ``HTTPException`` carries no handle on what was already applied: the
    local ``ViewBatchResult`` accumulating the applied prefix's
    ``inverse_units`` is a plain local — it is never returned and never
    attached to the exception — so the view is left mutated with the partial
    result UNREACHABLE by design. (Contrast the model applier's
    ``routes/ops.py::_apply_batch``, which is NOT a caller-rolls-back
    contract: it wraps its own loop and calls ``_rollback`` INTERNALLY, in
    its own ``except`` block, before re-raising — this function does not do
    that.) Callers that need atomicity must therefore not call this directly
    on a live view; the commit/undo wiring task adds
    ``apply_view_ops_atomic``, which loops op-by-op, keeps the accumulated
    ``inverse_units`` itself, and rolls them back via ``rollback_view`` before
    re-raising. For a dry run with no mutation at all, use
    ``validate_view_ops`` (deep-copy apply, discard) instead of trying to
    recover from a failed direct call.
    """
    res = ViewBatchResult(id_map=dict(id_map or {}))

    def rid(v: str) -> str:
        return res.id_map.get(v, v)

    for op in ops:
        if isinstance(op, CreateFolderOp):
            parent_id = rid(op.parent_id)
            container = _container(view, parent_id)
            if op.temp_id.startswith(TEMP_ID_PREFIX):
                folder_id = uuid.uuid4().hex
                res.id_map[op.temp_id] = folder_id
            elif restore:
                folder_id = op.temp_id  # reinstate the exact id
                if find_folder(view, folder_id) is not None:
                    raise _422(f"a folder with id {folder_id!r} already exists")
            else:
                raise _422(
                    f"create_folder temp_id {op.temp_id!r} must start "
                    f"with {TEMP_ID_PREFIX!r}"
                )
            index = _clamped(op.index, len(container.folders))
            container.folders.insert(index, Folder(id=folder_id, name=op.name))
            res.inverse_units.append(
                [DeleteFolderOp(kind="delete_folder", id=folder_id)]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "temp_id": folder_id,
                        "parent_id": parent_id,
                        "index": index,
                    }
                )
            )
        elif isinstance(op, RenameFolderOp):
            folder = _require_folder(view, rid(op.id))
            res.inverse_units.append(
                [RenameFolderOp(kind="rename_folder", id=folder.id, name=folder.name)]
            )
            folder.name = op.name
            res.canonical_ops.append(op.model_copy(update={"id": folder.id}))
        elif isinstance(op, MoveFolderOp):
            folder_id = rid(op.id)
            to_parent_id = rid(op.to_parent_id)
            located = locate_folder(view, folder_id)
            if located is None:
                raise _422(f"unknown folder {folder_id!r}")
            old_container, old_index = located
            moving = old_container.folders[old_index]
            if to_parent_id != VIEW_ROOT_ID and to_parent_id in _subtree_ids(moving):
                raise _422("cannot move a folder into its own subtree")
            # resolve the destination BEFORE popping (an unknown destination
            # must not half-apply), but pop before computing the clamp so a
            # same-container move clamps against the post-removal length.
            dest = _container(view, to_parent_id)
            old_container.folders.pop(old_index)
            index = _clamped(op.index, len(dest.folders))
            dest.folders.insert(index, moving)
            res.inverse_units.append(
                [
                    MoveFolderOp(
                        kind="move_folder",
                        id=moving.id,
                        to_parent_id=_container_id(old_container),
                        index=old_index,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "id": moving.id,
                        "to_parent_id": to_parent_id,
                        "index": index,
                    }
                )
            )
        elif isinstance(op, DeleteFolderOp):
            folder_id = rid(op.id)
            located = locate_folder(view, folder_id)
            if located is None:
                raise _422(f"unknown folder {folder_id!r}")
            container, index = located
            folder = container.folders[index]
            res.inverse_units.append(
                _recreate_ops(folder, _container_id(container), index)
            )
            container.folders.pop(index)
            res.canonical_ops.append(op.model_copy(update={"id": folder_id}))
        elif isinstance(op, PlaceElementOp):
            element_id = rid(op.element_id)
            folder_id = rid(op.folder_id)
            if folder_id == VIEW_ROOT_ID:
                raise _422(
                    "cannot place an element at the view root; an unplaced "
                    "element already renders there (use remove_element)"
                )
            folder = _require_folder(view, folder_id)
            if not restore:
                home = _element_home(view, element_id)
                if home is not None:
                    raise _422(
                        f"element {element_id!r} is already placed in folder "
                        f"{home.id!r} (use move_element)"
                    )
            index = _clamped(op.index, len(folder.elements))
            folder.elements.insert(index, element_id)
            res.inverse_units.append(
                [
                    RemoveElementOp(
                        kind="remove_element",
                        element_id=element_id,
                        folder_id=folder.id,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "element_id": element_id,
                        "folder_id": folder.id,
                        "index": index,
                    }
                )
            )
        elif isinstance(op, RemoveElementOp):
            element_id = rid(op.element_id)
            folder = _require_folder(view, rid(op.folder_id))
            if element_id not in folder.elements:
                raise _422(
                    f"element {element_id!r} is not placed in folder {folder.id!r}"
                )
            old_index = folder.elements.index(element_id)
            folder.elements.pop(old_index)
            res.inverse_units.append(
                [
                    PlaceElementOp(
                        kind="place_element",
                        element_id=element_id,
                        folder_id=folder.id,
                        index=old_index,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(update={"element_id": element_id, "folder_id": folder.id})
            )
        elif isinstance(op, MoveElementOp):
            element_id = rid(op.element_id)
            src = _require_folder(view, rid(op.from_folder_id))
            dst = _require_folder(view, rid(op.to_folder_id))
            if element_id not in src.elements:
                raise _422(f"element {element_id!r} is not placed in folder {src.id!r}")
            old_index = src.elements.index(element_id)
            src.elements.pop(old_index)
            index = _clamped(op.index, len(dst.elements))
            dst.elements.insert(index, element_id)
            res.inverse_units.append(
                [
                    MoveElementOp(
                        kind="move_element",
                        element_id=element_id,
                        from_folder_id=dst.id,
                        to_folder_id=src.id,
                        index=old_index,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "element_id": element_id,
                        "from_folder_id": src.id,
                        "to_folder_id": dst.id,
                        "index": index,
                    }
                )
            )
        elif isinstance(op, PlaceArtifactOp):
            artifact_id = rid(op.artifact_id)
            folder_id = rid(op.folder_id)
            container = _container(view, folder_id)
            if not restore and any(r.id == artifact_id for r in container.artifacts):
                raise _422(
                    f"artifact {artifact_id!r} is already placed in {folder_id!r}"
                )
            index = _clamped(op.index, len(container.artifacts))
            container.artifacts.insert(
                index, ArtifactRef(id=artifact_id, kind=op.artifact_kind)
            )
            res.inverse_units.append(
                [
                    RemoveArtifactOp(
                        kind="remove_artifact",
                        artifact_id=artifact_id,
                        folder_id=_container_id(container),
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "artifact_id": artifact_id,
                        "folder_id": _container_id(container),
                        "index": index,
                    }
                )
            )
        elif isinstance(op, RemoveArtifactOp):
            artifact_id = rid(op.artifact_id)
            container = _container(view, rid(op.folder_id))
            pos = next(
                (i for i, r in enumerate(container.artifacts) if r.id == artifact_id),
                None,
            )
            if pos is None:
                raise _422(
                    f"artifact {artifact_id!r} is not placed in "
                    f"{_container_id(container)!r}"
                )
            ref = container.artifacts.pop(pos)
            res.inverse_units.append(
                [
                    PlaceArtifactOp(
                        kind="place_artifact",
                        artifact_id=ref.id,
                        artifact_kind=ref.kind,
                        folder_id=_container_id(container),
                        index=pos,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "artifact_id": artifact_id,
                        "folder_id": _container_id(container),
                    }
                )
            )
        elif isinstance(op, MoveArtifactOp):
            artifact_id = rid(op.artifact_id)
            src_c = _container(view, rid(op.from_folder_id))
            dst_c = _container(view, rid(op.to_folder_id))
            pos = next(
                (i for i, r in enumerate(src_c.artifacts) if r.id == artifact_id), None
            )
            if pos is None:
                raise _422(
                    f"artifact {artifact_id!r} is not placed in "
                    f"{_container_id(src_c)!r}"
                )
            if (
                not restore
                and src_c is not dst_c
                and any(r.id == artifact_id for r in dst_c.artifacts)
            ):
                raise _422(
                    f"artifact {artifact_id!r} is already placed in "
                    f"{_container_id(dst_c)!r}"
                )
            ref = src_c.artifacts.pop(pos)
            index = _clamped(op.index, len(dst_c.artifacts))
            dst_c.artifacts.insert(index, ref)
            res.inverse_units.append(
                [
                    MoveArtifactOp(
                        kind="move_artifact",
                        artifact_id=ref.id,
                        from_folder_id=_container_id(dst_c),
                        to_folder_id=_container_id(src_c),
                        index=pos,
                    )
                ]
            )
            res.canonical_ops.append(
                op.model_copy(
                    update={
                        "artifact_id": artifact_id,
                        "from_folder_id": _container_id(src_c),
                        "to_folder_id": _container_id(dst_c),
                        "index": index,
                    }
                )
            )
        else:
            assert_never(op)
    return res


def apply_view_ops_atomic(
    view: View,
    ops: list[ViewOpIn],
    *,
    id_map: dict[str, str] | None = None,
    restore: bool = False,
) -> ViewBatchResult:
    """``apply_view_ops`` with all-or-nothing semantics: on ANY failure the
    already-applied prefix is rolled back via its own inverses before the
    exception propagates. The commit/undo callers want exactly this — they
    have no other handle on the partial result (see ``apply_view_ops``'s
    docstring, which points forward to this function).

    Applies op-by-op (rather than delegating the whole list to
    ``apply_view_ops`` in one call) so a mid-batch failure's already-collected
    ``inverse_units`` are available to roll back — ``apply_view_ops`` itself
    keeps no such handle on a partial result once it raises.
    """
    res = ViewBatchResult(id_map=dict(id_map or {}))
    try:
        for op in ops:
            step = apply_view_ops(view, [op], id_map=res.id_map, restore=restore)
            res.canonical_ops.extend(step.canonical_ops)
            res.inverse_units.extend(step.inverse_units)
            res.id_map.update(step.id_map)
    except Exception:
        rollback_view(view, res.inverse_units)
        raise
    return res


def rollback_view(view: View, inverse_units: list[list[ViewOpIn]]) -> None:
    """Undo an applied (possibly partial) batch: apply inverse units newest-
    first, each unit front-to-back, in restore mode. Inverses are exact by
    construction, so a failure here would mean the view was mutated behind the
    caller's back while it held the write mutex — let it propagate."""
    for unit in reversed(inverse_units):
        apply_view_ops(view, list(unit), restore=True)


def validate_view_ops(view: View | None, ops: list[ViewOpIn]) -> None:
    """Dry preview validation: apply against a deep copy and discard. Views
    are small (user-curated trees), so the copy is cheap; sharing the real
    applier means preview and commit can never disagree on a batch's
    validity. ``None`` validates against an empty view — the same auto-create
    a real commit performs (see routes/commits.py)."""
    base = view.model_copy(deep=True) if view is not None else View(name="view")
    apply_view_ops(base, ops, restore=False)


def view_op_folder_ids(view: View | None, ops: Sequence[ViewOpIn]) -> set[str]:
    """Every folder id (bare, un-namespaced) a batch references — the undo
    route's peer-lease guard input.

    Mostly over-reports on purpose (a create's temp/parent id, both ends of a
    move): a spurious id can only produce a conservative 409, never hide a
    held lease. But two op kinds need the SAME expansion ``required_locks``
    (``locking.py``) performs for a forward batch, or a genuinely-held peer
    lease goes unseen entirely — the false claim this docstring used to make
    (final-review Fix 2):

    - ``delete_folder`` only NAMES its own id, yet removes its whole subtree,
      so a peer's lease on any DESCENDANT must also block the undo that would
      delete it out from under them (``folder_subtree``, degrading to
      ``{op.id}`` when ``view`` is None/stale — total, like
      ``required_locks``'s own DELETE-intent expansion).
    - ``move_folder`` only names its DESTINATION parent — the op carries no
      field for where the folder currently lives — so a peer's lease on its
      CURRENT parent (resolved by walking ``view`` via ``locate_folder``,
      silently skipped if unresolvable) must also be reported.

    ``view`` is the CURRENT (pre-undo-application) view, exactly the state
    ``required_locks`` itself is evaluated against — the undo caller passes
    ``session.view`` before applying anything. Deliberately NOT reimplemented
    by delegating straight to ``required_locks``: that function's `created`
    bookkeeping (a batch's own same-batch creates need no lock) is correct
    for a FORWARD commit but wrong for a RESTORE-mode replay, where a
    ``create_folder`` reinstates a REAL, previously-existing id (e.g. inside
    a ``delete_folder``'s recreate unit) that a peer could still hold a lease
    on — delegating would silently exclude it."""
    ids: set[str] = set()
    for op in ops:
        if isinstance(op, CreateFolderOp):
            ids |= {op.temp_id, op.parent_id}
        elif isinstance(op, RenameFolderOp):
            ids.add(op.id)
        elif isinstance(op, DeleteFolderOp):
            ids |= set(folder_subtree(view, op.id))
        elif isinstance(op, MoveFolderOp):
            ids |= {op.id, op.to_parent_id}
            if view is not None:
                located = locate_folder(view, op.id)
                if located is not None:
                    parent = located[0]
                    ids.add(parent.id if isinstance(parent, Folder) else VIEW_ROOT_ID)
        elif isinstance(op, (PlaceElementOp, RemoveElementOp)):
            ids.add(op.folder_id)
        elif isinstance(op, MoveElementOp):
            ids |= {op.from_folder_id, op.to_folder_id}
        elif isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
            ids.add(op.folder_id)
        elif isinstance(op, MoveArtifactOp):
            ids |= {op.from_folder_id, op.to_folder_id}
        else:
            assert_never(op)
    return ids


#: Placement-subject namespaces for the conflict backstop ONLY (no lease ever
#: carries them): two batches fighting over the same element's/artifact-ref's
#: placement must conflict even when the folders they name are disjoint —
#: folder leases cannot see that collision, the overlap check can.
VIEW_ELEMENT_MARKER = "viewel:"
VIEW_ARTIFACT_MARKER = "viewart:"


def view_touched_resources(op: ViewOpIn) -> set[str]:
    """The backstop resources one view op touches: every folder it names in
    the ``folder:`` lease namespace (so the set compares directly against
    lease ids and the tail's), plus a subject marker per placement. Folder
    ids here may be temp ids in a CLIENT batch — the caller strips those; in
    CANONICAL journal ops they are always real (the applier rewrote them)."""
    if isinstance(op, CreateFolderOp):
        return {folder_resource(op.temp_id), folder_resource(op.parent_id)}
    if isinstance(op, (RenameFolderOp, DeleteFolderOp)):
        # a delete's subtree victims surface via the INVERSE unit's create
        # ops when _affected_ids scans both halves (same cascade rationale
        # as delete_element).
        return {folder_resource(op.id)}
    if isinstance(op, MoveFolderOp):
        return {folder_resource(op.id), folder_resource(op.to_parent_id)}
    if isinstance(op, (PlaceElementOp, RemoveElementOp)):
        return {folder_resource(op.folder_id), VIEW_ELEMENT_MARKER + op.element_id}
    if isinstance(op, MoveElementOp):
        return {
            folder_resource(op.from_folder_id),
            folder_resource(op.to_folder_id),
            VIEW_ELEMENT_MARKER + op.element_id,
        }
    if isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
        return {folder_resource(op.folder_id), VIEW_ARTIFACT_MARKER + op.artifact_id}
    if isinstance(op, MoveArtifactOp):
        return {
            folder_resource(op.from_folder_id),
            folder_resource(op.to_folder_id),
            VIEW_ARTIFACT_MARKER + op.artifact_id,
        }
    assert_never(op)
