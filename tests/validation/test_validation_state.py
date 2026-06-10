"""Unit tests for the incremental issue store (core/validation/state.py)."""

from __future__ import annotations

import pytest

from data_rover.core.validation.issue import Issue, Severity
from data_rover.core.validation.state import (
    IssuesDelta,
    ValidationState,
    issue_owner,
)


def _issue(owner: str, message: str, severity: Severity = Severity.ERROR) -> Issue:
    return Issue(severity, message, [owner])


def test_issue_owner_is_first_target_id():
    assert issue_owner(Issue(Severity.ERROR, "m", ["a", "b"])) == "a"
    # owner-less issues would be keyed under the "" sentinel, which never
    # appears in a dirty set — the debug assert rejects them outright
    with pytest.raises(AssertionError):
        issue_owner(Issue(Severity.ERROR, "m", []))


def test_set_full_groups_by_owner_preserving_order():
    state = ValidationState()
    i1 = _issue("a", "first")
    i2 = _issue("b", "second")
    i3 = _issue("a", "third")
    state.set_full([i1, i2, i3])
    assert state.issues_by_owner == {"a": [i1, i3], "b": [i2]}
    assert state.all_issues() == [i1, i3, i2]


def test_replace_drops_dirty_owners_and_inserts_new_issues():
    state = ValidationState()
    a1 = _issue("a", "a-old")
    b1 = _issue("b", "b-keep")
    c1 = _issue("c", "c-old")
    state.set_full([a1, b1, c1])

    a2 = _issue("a", "a-new")
    delta = state.replace(["a", "c", "ghost"], [a2])

    assert isinstance(delta, IssuesDelta)
    # only owners that actually had issues are reported as removed
    assert delta.removed_owner_ids == ["a", "c"]
    assert delta.added == [a2]
    assert state.all_issues() == [b1, a2]


def test_replace_deleted_owner_cleanup():
    """Issues owned by deleted entities vanish: the deleted id is in the
    dirty set and the scoped run produces nothing for it."""
    state = ValidationState()
    gone = _issue("deleted-el", "stale")
    keep = _issue("other", "keep")
    state.set_full([gone, keep])

    delta = state.replace(["deleted-el"], [])
    assert delta.removed_owner_ids == ["deleted-el"]
    assert delta.added == []
    assert state.all_issues() == [keep]


def test_replace_inserts_for_previously_clean_owner():
    state = ValidationState()
    state.set_full([])
    new = _issue("fresh", "now dirty")
    delta = state.replace(["fresh"], [new])
    assert delta.removed_owner_ids == []
    assert state.all_issues() == [new]


def test_replace_dirty_iterated_once_despite_duplicates():
    state = ValidationState()
    state.set_full([_issue("a", "x")])
    delta = state.replace(["a", "a"], [])
    assert delta.removed_owner_ids == ["a"]
    assert state.all_issues() == []


def test_counts_by_severity_value():
    state = ValidationState()
    state.set_full(
        [
            _issue("a", "e1"),
            _issue("b", "e2"),
            _issue("c", "w1", Severity.WARNING),
        ]
    )
    assert state.counts() == {"error": 2, "warning": 1}
    state.replace(["a"], [])
    assert state.counts() == {"error": 1, "warning": 1}


def test_all_issues_keeps_insertion_order_stable_across_replace():
    state = ValidationState()
    a1 = _issue("a", "a1")
    b1 = _issue("b", "b1")
    c1 = _issue("c", "c1")
    state.set_full([a1, b1, c1])
    a2 = _issue("a", "a2")
    state.replace(["a"], [a2])
    # untouched owners keep their relative order; re-validated owners append
    assert state.all_issues() == [b1, c1, a2]
