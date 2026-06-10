from data_rover.core.validation.issue import Issue, Severity
from data_rover.core.validation.scope import Scope


def test_issue_holds_fields():
    issue = Issue(severity=Severity.ERROR, message="bad", target_ids=["e1"])
    assert issue.severity is Severity.ERROR
    assert issue.target_ids == ["e1"]


def test_scope_all_includes_everything():
    s = Scope.all()
    assert s.is_all is True
    assert s.includes("anything") is True


def test_scope_subset_includes_only_listed():
    s = Scope({"a", "b"})
    assert s.includes("a") is True
    assert s.includes("z") is False
    assert s.is_all is False


def test_scope_ids_preserve_insertion_order():
    # first occurrence wins, duplicates dropped; iteration replays the
    # caller's order so scoped issue output is deterministic
    s = Scope(["b", "a", "c", "a"])
    assert s.ids is not None
    assert list(s.ids) == ["b", "a", "c"]
