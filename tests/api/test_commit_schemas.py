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
