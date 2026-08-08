"""Folder identity (artefacts revamp Phase 2): ids are assigned lazily, never
reassigned once present, and the reserved root id / duplicates are healed.
`ensure_folder_ids` is the ONE assignment path — hydration and the importer
both call it, so these tests pin the healing rules for both."""

from __future__ import annotations

from data_rover.core.view.ids import (
    ensure_folder_ids,
    find_folder,
    folder_subtree,
    iter_folders,
    locate_folder,
)
from data_rover.core.view.schema import VIEW_ROOT_ID, Folder, View


def _view() -> View:
    return View(
        name="v",
        folders=[
            Folder(
                name="A",
                folders=[Folder(name="A1"), Folder(name="A2")],
                elements=["e1"],
            ),
            Folder(name="B"),
        ],
    )


def test_old_blob_parses_with_empty_ids() -> None:
    v = View.model_validate({"name": "v", "folders": [{"name": "A"}]})
    assert v.folders[0].id == ""


def test_ensure_assigns_ids_everywhere_and_reports_change() -> None:
    v = _view()
    assert ensure_folder_ids(v) is True
    ids = [f.id for f in iter_folders(v)]
    assert len(ids) == 4
    assert all(len(i) == 32 for i in ids)  # uuid4().hex
    assert len(set(ids)) == 4


def test_ensure_is_idempotent_and_preserves_existing_ids() -> None:
    v = _view()
    ensure_folder_ids(v)
    before = [f.id for f in iter_folders(v)]
    assert ensure_folder_ids(v) is False
    assert [f.id for f in iter_folders(v)] == before


def test_ensure_heals_duplicates_and_reserved_root_id() -> None:
    v = View(
        name="v",
        folders=[
            Folder(id="dup", name="A"),
            Folder(id="dup", name="B"),
            Folder(id=VIEW_ROOT_ID, name="C"),
        ],
    )
    assert ensure_folder_ids(v) is True
    ids = [f.id for f in v.folders]
    assert ids[0] == "dup"  # first occurrence keeps its id
    assert ids[1] != "dup" and ids[2] != VIEW_ROOT_ID
    assert len(set(ids)) == 3


def test_find_and_locate() -> None:
    v = _view()
    ensure_folder_ids(v)
    a = v.folders[0]
    a1 = a.folders[0]
    assert find_folder(v, a1.id) is a1
    assert find_folder(v, "missing") is None
    parent, idx = locate_folder(v, a1.id)  # type: ignore[misc]
    assert parent is a and idx == 0
    parent, idx = locate_folder(v, a.id)  # type: ignore[misc]
    assert parent is v and idx == 0
    assert locate_folder(v, "missing") is None


def test_folder_subtree() -> None:
    v = _view()
    ensure_folder_ids(v)
    a = v.folders[0]
    sub = folder_subtree(v, a.id)
    assert sub[0] == a.id
    assert set(sub) == {a.id, a.folders[0].id, a.folders[1].id}
    assert folder_subtree(v, "missing") == ["missing"]
    assert folder_subtree(None, "x") == ["x"]
