"""View-op applier: apply/inverse symmetry (the invariant undo and the diff
API lean on — apply-then-inverse must restore a byte-identical blob), the
422 rules, id resolution, and restore mode."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from data_rover.api.schemas import (
    CreateFolderOp,
    DeleteFolderOp,
    MoveElementOp,
    MoveFolderOp,
    PlaceArtifactOp,
    PlaceElementOp,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
    ViewOpIn,
)
from data_rover.api.view_ops import (
    apply_view_ops,
    apply_view_ops_atomic,
    rollback_view,
    validate_view_ops,
    view_op_folder_ids,
)
from data_rover.core.view.ids import ensure_folder_ids, find_folder
from data_rover.core.view.schema import ArtifactRef, Folder, View


def _view() -> View:
    v = View(
        name="v",
        folders=[
            Folder(
                name="A",
                folders=[Folder(name="A1")],
                elements=["e1", "e2"],
                artifacts=[ArtifactRef(id="a1", kind="table")],
            ),
            Folder(name="B"),
        ],
        artifacts=[ArtifactRef(id="a2", kind="navigation")],
    )
    ensure_folder_ids(v)
    return v


def _ids(v: View) -> dict[str, str]:
    return {f.name: f.id for f in [*v.folders, *v.folders[0].folders]}


def test_apply_inverse_restores_byte_identical_blob() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    ops = [
        CreateFolderOp(kind="create_folder", temp_id="tmp_c", parent_id=f["B"], name="C"),
        RenameFolderOp(kind="rename_folder", id=f["A"], name="A-renamed"),
        PlaceElementOp(kind="place_element", element_id="e9", folder_id="tmp_c", index=0),
        MoveElementOp(
            kind="move_element",
            element_id="e1",
            from_folder_id=f["A"],
            to_folder_id=f["B"],
            index=None,
        ),
        MoveFolderOp(kind="move_folder", id=f["A1"], to_parent_id="root", index=0),
        PlaceArtifactOp(
            kind="place_artifact",
            artifact_id="a3",
            artifact_kind="code_snippet",
            folder_id="root",
            index=1,
        ),
        RemoveArtifactOp(kind="remove_artifact", artifact_id="a1", folder_id=f["A"]),
        DeleteFolderOp(kind="delete_folder", id=f["A"]),
    ]
    res = apply_view_ops(v, ops)
    assert v.model_dump_json() != before
    rollback_view(v, res.inverse_units)
    assert v.model_dump_json() == before


def test_canonical_ops_concretize_ids_and_indices() -> None:
    v = _view()
    f = _ids(v)
    res = apply_view_ops(
        v,
        [
            CreateFolderOp(kind="create_folder", temp_id="tmp_c", parent_id="root", name="C"),
            PlaceElementOp(kind="place_element", element_id="e9", folder_id="tmp_c", index=None),
        ],
    )
    created = res.canonical_ops[0]
    assert isinstance(created, CreateFolderOp)
    assert not created.temp_id.startswith("tmp_") and created.index == 2
    placed = res.canonical_ops[1]
    assert isinstance(placed, PlaceElementOp)
    assert placed.folder_id == created.temp_id == res.id_map["tmp_c"]
    assert placed.index == 0


def test_delete_folder_inverse_recreates_subtree() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    res = apply_view_ops(v, [DeleteFolderOp(kind="delete_folder", id=f["A"])])
    assert find_folder(v, f["A"]) is None
    # the single inverse unit replays parent-before-child with placements
    unit = res.inverse_units[0]
    kinds = [op.kind for op in unit]
    assert kinds[0] == "create_folder" and "place_element" in kinds
    rollback_view(v, res.inverse_units)
    assert v.model_dump_json() == before


def _expect_422(v: View, op: ViewOpIn, detail: str) -> None:
    with pytest.raises(HTTPException) as exc:
        apply_view_ops(v, [op])
    assert exc.value.status_code == 422
    assert detail in str(exc.value.detail)


def test_unknown_folder_422() -> None:
    _expect_422(
        _view(),
        RenameFolderOp(kind="rename_folder", id="missing", name="x"),
        "unknown folder",
    )


def test_place_element_at_root_422() -> None:
    _expect_422(
        _view(),
        PlaceElementOp(kind="place_element", element_id="e9", folder_id="root"),
        "cannot place an element at the view root",
    )


def test_place_already_placed_element_422() -> None:
    v = _view()
    f = _ids(v)
    _expect_422(
        v,
        PlaceElementOp(kind="place_element", element_id="e1", folder_id=f["B"]),
        "already placed",
    )


def test_remove_unplaced_element_422() -> None:
    v = _view()
    f = _ids(v)
    _expect_422(
        v,
        RemoveElementOp(kind="remove_element", element_id="e9", folder_id=f["A"]),
        "not placed",
    )


def test_move_folder_cycle_422() -> None:
    v = _view()
    f = _ids(v)
    with pytest.raises(HTTPException) as exc:
        apply_view_ops(
            v, [MoveFolderOp(kind="move_folder", id=f["A"], to_parent_id=f["A1"])]
        )
    assert exc.value.status_code == 422
    assert "own subtree" in str(exc.value.detail)


def test_mid_batch_failure_leaves_prefix_applied() -> None:
    """apply_view_ops does NOT roll itself back — mirrors _apply_batch's
    caller contract (Task 7 adds apply_view_ops_atomic for callers that want
    all-or-nothing). The pinned behavior: the applied prefix stays, and the
    exception fires on the offending op."""
    v = _view()
    f = _ids(v)
    ops: list[ViewOpIn] = [
        RenameFolderOp(kind="rename_folder", id=f["B"], name="B2"),
        RenameFolderOp(kind="rename_folder", id="missing", name="boom"),
    ]
    with pytest.raises(HTTPException):
        apply_view_ops(v, ops)
    assert v.folders[1].name == "B2"


def test_restore_mode_reinstates_exact_ids_and_tolerates_duplicates() -> None:
    v = _view()
    f = _ids(v)
    res = apply_view_ops(v, [DeleteFolderOp(kind="delete_folder", id=f["A"])])
    # peer places e1 somewhere else after the delete
    apply_view_ops(
        v,
        [PlaceElementOp(kind="place_element", element_id="e1", folder_id=f["B"])],
    )
    # undo of the delete replays the recreate unit in restore mode: the
    # duplicate e1 placement is TOLERATED (validate_view warns; first wins)
    restored = apply_view_ops(v, res.inverse_units[0], restore=True)
    assert find_folder(v, f["A"]) is not None
    recreated = restored.canonical_ops[0]
    assert isinstance(recreated, CreateFolderOp)
    assert recreated.temp_id == f["A"]


def test_apply_view_ops_atomic_rolls_back_prefix() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    with pytest.raises(HTTPException):
        apply_view_ops_atomic(
            v,
            [
                RenameFolderOp(kind="rename_folder", id=f["B"], name="B2"),
                RenameFolderOp(kind="rename_folder", id="missing", name="x"),
            ],
        )
    assert v.model_dump_json() == before


def test_validate_view_ops_is_dry() -> None:
    v = _view()
    f = _ids(v)
    before = v.model_dump_json()
    validate_view_ops(v, [RenameFolderOp(kind="rename_folder", id=f["A"], name="x")])
    assert v.model_dump_json() == before
    with pytest.raises(HTTPException):
        validate_view_ops(v, [RenameFolderOp(kind="rename_folder", id="missing", name="x")])
    # None view validates against an empty view (the auto-create commit path)
    validate_view_ops(
        None,
        [CreateFolderOp(kind="create_folder", temp_id="tmp_x", parent_id="root", name="F")],
    )


def test_view_op_folder_ids() -> None:
    ops = [
        MoveElementOp(
            kind="move_element", element_id="e", from_folder_id="f1", to_folder_id="f2"
        ),
        CreateFolderOp(kind="create_folder", temp_id="tmp_c", parent_id="f3", name="x"),
    ]
    # `view` is only consulted by the delete_folder/move_folder branches
    # below; None is fine for op kinds that never need it.
    assert view_op_folder_ids(None, ops) == {"f1", "f2", "f3", "tmp_c"}


def test_view_op_folder_ids_delete_folder_expands_subtree() -> None:
    """Regression for the artefacts-revamp final-review Fix 2: a
    ``delete_folder`` op only NAMES its own id, but deleting it removes its
    whole subtree — the undo route's peer-lease guard must see every
    descendant too, or a peer's lease on a CHILD folder goes unenforced (the
    docstring's old "over-reports on purpose, never hides a lease" claim was
    false for exactly this op kind)."""
    v = _view()
    f = _ids(v)
    assert view_op_folder_ids(v, [DeleteFolderOp(kind="delete_folder", id=f["A"])]) == {
        f["A"],
        f["A1"],
    }


def test_view_op_folder_ids_move_folder_resolves_current_parent() -> None:
    """Regression for the artefacts-revamp final-review Fix 2: ``move_folder``
    only names its DESTINATION parent in the op itself — the folder's CURRENT
    parent (resolved by walking ``view``, exactly like ``required_locks``
    does) must also be reported, or a peer's lease on the folder's old
    container goes unenforced."""
    v = _view()
    f = _ids(v)
    ids = view_op_folder_ids(
        v, [MoveFolderOp(kind="move_folder", id=f["A1"], to_parent_id="root")]
    )
    assert ids == {f["A1"], "root", f["A"]}  # f["A"] is A1's CURRENT parent


def test_view_op_folder_ids_delete_folder_falls_back_without_view() -> None:
    """``folder_subtree`` degrades to a single-resource id when ``view`` is
    None or the id is unknown (mirrors ``required_locks``'s own total-ness
    guarantee) rather than raising — lock/guard derivation must never crash
    on a stale or malformed op."""
    assert view_op_folder_ids(None, [DeleteFolderOp(kind="delete_folder", id="x")]) == {
        "x"
    }
