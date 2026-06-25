from __future__ import annotations

from data_rover.api.routes.validation import classify_issue_origins
from data_rover.core.validation.issue import Issue, Severity


def _issue(msg: str, owner: str, sev: Severity = Severity.ERROR) -> Issue:
    return Issue(severity=sev, message=msg, target_ids=[owner])


def test_classify_tags_on_server_uncommitted_and_resolved() -> None:
    pre_existing = _issue("dangling ref", "z1")
    fixed = _issue("name not unique", "r2")
    committed = [pre_existing, fixed]

    introduced = _issue("priority above max", "req1")
    working = [pre_existing, introduced]  # `fixed` is gone, `introduced` is new

    out = classify_issue_origins(committed, working)
    by_msg = {o.message: o.origin for o in out}

    assert by_msg["dangling ref"] == "on_server"
    assert by_msg["priority above max"] == "uncommitted"
    assert by_msg["name not unique"] == "resolved"
    # resolved issues are returned in addition to the working set
    assert len(out) == 3


def test_classify_duplicate_issues_use_multiset_matching() -> None:
    committed = [_issue("dup", "a")]
    working = [_issue("dup", "a"), _issue("dup", "a")]  # one pre-existing, one new

    origins = sorted(o.origin for o in classify_issue_origins(committed, working))
    assert origins == ["on_server", "uncommitted"]
