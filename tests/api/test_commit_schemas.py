from __future__ import annotations

from data_rover.api.schemas import (
    CommitRequest,
    IssueOut,
    LockRequest,
    PreviewResponse,
)
from data_rover.core.validation.issue import Issue, IssueCategory, Severity


def test_issue_out_carries_category() -> None:
    out = IssueOut.from_core(
        Issue(Severity.ERROR, "dangling", ["e1"], IssueCategory.STRUCTURAL)
    )
    assert out.category == "structural"


def test_lock_request_parses_targets_and_intent() -> None:
    req = LockRequest.model_validate(
        {"targets": [{"resource_id": "e1", "mode": "exclusive"}], "intent": "delete"}
    )
    assert req.targets[0].resource_id == "e1"
    assert req.intent == "delete"
    assert req.steal is False


def test_commit_request_requires_lock_tokens() -> None:
    req = CommitRequest.model_validate(
        {"base_rev": 3, "ops": [], "lock_tokens": ["t1"], "message": "m"}
    )
    assert req.lock_tokens == ["t1"]


def test_preview_response_shape() -> None:
    pr = PreviewResponse(conformance_error_count=2, structural_blockers=[], issues=[])
    assert pr.conformance_error_count == 2


def test_metamodel_ops_round_trip_through_adapter() -> None:
    """The journal adapter must round-trip the metamodel family with kind
    tags intact (same guarantee the other three families have)."""
    from data_rover.api.schemas import (
        METAMODEL_OP_KINDS,
        OPS_ADAPTER,
        MetamodelNodePos,
        MoveMetamodelNodeOp,
        RebindMetamodelOp,
    )

    ops = [
        RebindMetamodelOp(kind="metamodel.rebind", blob="elements:\n  - name: A\n"),
        MoveMetamodelNodeOp(
            kind="metamodel.move_node",
            node="el:A",
            pos=MetamodelNodePos(x=1.5, y=-2.0),
        ),
        MoveMetamodelNodeOp(kind="metamodel.move_node", node="el:B", pos=None),
    ]
    raw = OPS_ADAPTER.dump_python(list(ops), mode="json")
    assert [o["kind"] for o in raw] == [
        "metamodel.rebind",
        "metamodel.move_node",
        "metamodel.move_node",
    ]
    assert raw[2]["pos"] is None
    back = OPS_ADAPTER.validate_python(raw)
    assert back == ops
    assert METAMODEL_OP_KINDS == {"metamodel.rebind", "metamodel.move_node"}
