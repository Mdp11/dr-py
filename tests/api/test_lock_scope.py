from __future__ import annotations

from data_rover.api.locking import (
    LockIntent,
    LockMode,
    expand_targets,
    required_locks,
)
from data_rover.api.schemas import (
    OPS_ADAPTER,
    CreateRelationshipOp,
    DeleteElementOp,
    UpdateElementOp,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.view.ids import ensure_folder_ids
from data_rover.core.view.schema import Folder, View

MM = """
name: scope-test
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    mappings:
      - source: Node
        target: Node
  - name: Links
    mappings:
      - source: Node
        target: Node
"""


def _model() -> Model:
    return Model(load_metamodel_str(MM))


def test_set_property_needs_exclusive_on_element() -> None:
    m = _model()
    e = m.create_element("Node")
    reqs = required_locks(
        m, None, [UpdateElementOp(kind="update_element", id=e.id, properties_patch={})]
    )
    assert reqs == [
        __import__("data_rover.api.locking", fromlist=["RequiredLock"]).RequiredLock(
            resource_id=e.id, mode=LockMode.EXCLUSIVE, intent=LockIntent.EDIT
        )
    ]


def test_connect_needs_exclusive_source_and_shared_target() -> None:
    m = _model()
    a = m.create_element("Node")
    b = m.create_element("Node")
    reqs = required_locks(
        m,
        None,
        [
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Links",
                source_id=a.id,
                target_id=b.id,
                properties={},
            )
        ],
    )
    modes = {(r.resource_id, r.mode) for r in reqs}
    assert (a.id, LockMode.EXCLUSIVE) in modes
    assert (b.id, LockMode.SHARED) in modes


def test_connect_skips_temp_endpoints() -> None:
    m = _model()
    a = m.create_element("Node")
    reqs = required_locks(
        m,
        None,
        [
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Links",
                source_id=a.id,
                target_id="tmp_new",  # created elsewhere in the batch
                properties={},
            )
        ],
    )
    # only the existing source is locked; the temp target is not yet shared
    assert {(r.resource_id, r.mode) for r in reqs} == {(a.id, LockMode.EXCLUSIVE)}


def test_delete_expands_to_containment_subtree() -> None:
    m = _model()
    root = m.create_element("Node")
    child = m.create_element("Node")
    grand = m.create_element("Node")
    m.connect("Contains", root.id, child.id)
    m.connect("Contains", child.id, grand.id)
    reqs = required_locks(m, None, [DeleteElementOp(kind="delete_element", id=root.id)])
    assert {r.resource_id for r in reqs} == {root.id, child.id, grand.id}
    assert all(r.mode is LockMode.EXCLUSIVE and r.intent is LockIntent.DELETE for r in reqs)


def test_expand_targets_delete_intent_walks_subtree() -> None:
    m = _model()
    root = m.create_element("Node")
    child = m.create_element("Node")
    m.connect("Contains", root.id, child.id)
    reqs = expand_targets(m, None, [(root.id, LockMode.EXCLUSIVE)], LockIntent.DELETE)
    assert {r.resource_id for r in reqs} == {root.id, child.id}


def _v() -> View:
    v = View(
        name="v",
        folders=[Folder(name="A", folders=[Folder(name="A1")]), Folder(name="B")],
    )
    ensure_folder_ids(v)
    return v


def test_required_locks_folder_ops() -> None:
    m = _model()
    v = _v()
    a, a1, b = v.folders[0], v.folders[0].folders[0], v.folders[1]
    ops = OPS_ADAPTER.validate_python(
        [
            {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": b.id, "name": "C"},
            {"kind": "rename_folder", "id": b.id, "name": "B2"},
            {"kind": "delete_folder", "id": a.id},
            {
                "kind": "move_folder",
                "id": a1.id,
                "to_parent_id": "root",
            },
            {"kind": "place_element", "element_id": "e1", "folder_id": "tmp_c"},
        ]
    )
    reqs = {(r.resource_id, r.mode, r.intent) for r in required_locks(m, v, ops)}
    assert (f"folder:{b.id}", LockMode.EXCLUSIVE, LockIntent.CREATE_CHILD) in reqs
    assert (f"folder:{b.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    # delete expands over the subtree
    assert (f"folder:{a.id}", LockMode.EXCLUSIVE, LockIntent.DELETE) in reqs
    assert (f"folder:{a1.id}", LockMode.EXCLUSIVE, LockIntent.DELETE) in reqs
    # move locks source parent (A — resolved from the view) and destination (root)
    assert (f"folder:{a.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    assert ("folder:root", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    # placement into the same-batch-created folder needs no lease
    assert not any(rid == "folder:tmp_c" for rid, _, _ in reqs)


def test_required_locks_element_and_artifact_placement_ops() -> None:
    """The six placement/move op kinds `test_required_locks_folder_ops` does
    NOT exercise (its one `place_element` targets a same-batch-created temp
    folder, asserting the EXEMPTION rather than the normal lock derivation).
    Each op below targets a DIFFERENT real folder so the resulting set can
    only contain a given `(resource_id, mode, intent)` tuple if THAT op
    contributed it — a from/to field mix-up, a wrong-field read, or a
    forgotten `add()` call on either endpoint of a move would each shrink the
    asserted set and fail loudly, rather than being masked by another op
    happening to touch the same folder."""
    m = _model()
    v = View(
        name="v2",
        folders=[Folder(name=n) for n in ("F1", "F2", "F3", "F4", "F5", "F6", "F7")],
    )
    ensure_folder_ids(v)
    f1, f2, f3, f4, f5, f6, f7 = v.folders
    ops = OPS_ADAPTER.validate_python(
        [
            {"kind": "place_element", "element_id": "e1", "folder_id": f1.id},
            {"kind": "remove_element", "element_id": "e2", "folder_id": f2.id},
            {
                "kind": "move_element",
                "element_id": "e3",
                "from_folder_id": f3.id,
                "to_folder_id": f4.id,
            },
            # artifacts have a real root list — root membership is a genuine
            # lease target, not just an "unplaced" no-op like element root.
            {
                "kind": "place_artifact",
                "artifact_id": "art1",
                "artifact_kind": "table",
                "folder_id": "root",
            },
            {"kind": "remove_artifact", "artifact_id": "art2", "folder_id": f5.id},
            {
                "kind": "move_artifact",
                "artifact_id": "art3",
                "from_folder_id": f6.id,
                "to_folder_id": f7.id,
            },
        ]
    )
    reqs = {(r.resource_id, r.mode, r.intent) for r in required_locks(m, v, ops)}
    assert (f"folder:{f1.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs  # place_element
    assert (f"folder:{f2.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs  # remove_element
    # move_element locks BOTH endpoints
    assert (f"folder:{f3.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    assert (f"folder:{f4.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    # place_artifact into the root list locks folder:root, same as a real folder
    assert ("folder:root", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    assert (f"folder:{f5.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs  # remove_artifact
    # move_artifact locks BOTH endpoints
    assert (f"folder:{f6.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    assert (f"folder:{f7.id}", LockMode.EXCLUSIVE, LockIntent.EDIT) in reqs
    # exactly these eight resources — no extra, no missing
    assert reqs == {
        (f"folder:{f1.id}", LockMode.EXCLUSIVE, LockIntent.EDIT),
        (f"folder:{f2.id}", LockMode.EXCLUSIVE, LockIntent.EDIT),
        (f"folder:{f3.id}", LockMode.EXCLUSIVE, LockIntent.EDIT),
        (f"folder:{f4.id}", LockMode.EXCLUSIVE, LockIntent.EDIT),
        ("folder:root", LockMode.EXCLUSIVE, LockIntent.EDIT),
        (f"folder:{f5.id}", LockMode.EXCLUSIVE, LockIntent.EDIT),
        (f"folder:{f6.id}", LockMode.EXCLUSIVE, LockIntent.EDIT),
        (f"folder:{f7.id}", LockMode.EXCLUSIVE, LockIntent.EDIT),
    }


def test_expand_targets_folder_delete_subtree() -> None:
    m = _model()
    v = _v()
    a = v.folders[0]
    reqs = expand_targets(
        m,
        v,
        [(f"folder:{a.id}", LockMode.EXCLUSIVE)],
        LockIntent.DELETE,
    )
    ids = {r.resource_id for r in reqs}
    assert ids == {f"folder:{a.id}", f"folder:{a.folders[0].id}"}


def test_metamodel_ops_require_the_mm_exclusive_lease() -> None:
    from data_rover.api.locking import LockIntent, LockMode, required_locks
    from data_rover.api.schemas import MoveMetamodelNodeOp, RebindMetamodelOp
    from data_rover.core.metamodel.loader import load_metamodel_str
    from data_rover.core.model.model import Model

    model = Model(load_metamodel_str("elements:\n  - name: A\n"))
    reqs = required_locks(
        model,
        None,
        [
            RebindMetamodelOp(kind="metamodel.rebind", blob="x: 1\n"),
            MoveMetamodelNodeOp(kind="metamodel.move_node", node="el:A", pos=None),
        ],
    )
    assert [(r.resource_id, r.mode, r.intent) for r in reqs] == [
        ("mm", LockMode.EXCLUSIVE, LockIntent.EDIT)
    ]
