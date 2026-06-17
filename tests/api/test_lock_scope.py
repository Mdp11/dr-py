from __future__ import annotations

from data_rover.api.locking import (
    LockIntent,
    LockMode,
    expand_targets,
    required_locks,
)
from data_rover.api.schemas import (
    CreateRelationshipOp,
    DeleteElementOp,
    UpdateElementOp,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

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
    reqs = required_locks(m, [UpdateElementOp(kind="update_element", id=e.id, properties_patch={})])
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
    reqs = required_locks(m, [DeleteElementOp(kind="delete_element", id=root.id)])
    assert {r.resource_id for r in reqs} == {root.id, child.id, grand.id}
    assert all(r.mode is LockMode.EXCLUSIVE and r.intent is LockIntent.DELETE for r in reqs)


def test_expand_targets_delete_intent_walks_subtree() -> None:
    m = _model()
    root = m.create_element("Node")
    child = m.create_element("Node")
    m.connect("Contains", root.id, child.id)
    reqs = expand_targets(m, [(root.id, LockMode.EXCLUSIVE)], LockIntent.DELETE)
    assert {r.resource_id for r in reqs} == {root.id, child.id}
